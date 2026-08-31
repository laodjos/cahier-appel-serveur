const express = require("express");
const crypto = require("crypto");
const { pool } = require("../config/db");
const { authRequired, requireRole } = require("../middleware/auth");
const { creerLienPaiement, verifierTransaction } = require("../services/paymentService");

const router = express.Router();

// GET /api/paiements?ecole_id=... — historique des paiements (Super-administrateur)
router.get("/", authRequired, requireRole("super_admin"), async (req, res) => {
  const { ecole_id } = req.query;
  const params = [];
  let filtre = "TRUE";
  if (ecole_id) { params.push(ecole_id); filtre = `ecole_id = $${params.length}`; }
  const { rows } = await pool.query(`SELECT * FROM paiements WHERE ${filtre} ORDER BY created_at DESC LIMIT 100`, params);
  res.json(rows);
});

// POST /api/paiements/initier  { ecole_id, montant, mois_ajoutes }
// Réservé au Super-administrateur — crée une session de paiement Orange Money
// et renvoie l'URL vers laquelle rediriger l'école pour qu'elle paie.
router.post("/initier", authRequired, requireRole("super_admin"), async (req, res) => {
  const { ecole_id, montant, mois_ajoutes } = req.body;
  if (!ecole_id || !montant) return res.status(400).json({ error: "ecole_id et montant sont requis." });

  const { rows: ecoleRows } = await pool.query("SELECT nom FROM ecoles WHERE id = $1", [ecole_id]);
  if (!ecoleRows[0]) return res.status(404).json({ error: "École introuvable." });

  const referenceExterne = crypto.randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO paiements (ecole_id, montant, mois_ajoutes, reference_externe, statut)
     VALUES ($1, $2, $3, $4, 'en_attente') RETURNING *`,
    [ecole_id, montant, mois_ajoutes || 1, referenceExterne]
  );

  const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
  try {
    const session = await creerLienPaiement({
      montant,
      transactionId: referenceExterne,
      description: `Renouvellement ${ecoleRows[0].nom}`,
      clientNom: ecoleRows[0].nom,
      returnUrl: `${baseUrl}/api/paiements/retour?reference=${referenceExterne}`,
      notifyUrl: `${baseUrl}/api/paiements/webhook-cinetpay`,
    });
    res.status(201).json({ paiement: rows[0], payment_url: session.payment_url });
  } catch (err) {
    await pool.query("UPDATE paiements SET statut = 'echoue' WHERE id = $1", [rows[0].id]);
    console.error("Échec de création du lien de paiement CinetPay :", err.response?.data || err.message);
    res.status(502).json({ error: "Impossible de créer le lien de paiement CinetPay. Vérifie la configuration (voir .env.example)." });
  }
});

// --------------------------------------------------------------------------
// POST /api/paiements/webhook-cinetpay — appelé par CinetPay lui-même côté
// serveur (pas par le navigateur de l'école) pour notifier qu'un paiement a
// été effectué. Par sécurité, on ne se contente JAMAIS du contenu de cette
// requête pour valider le paiement : on revérifie systématiquement le vrai
// statut directement auprès de CinetPay avant de créditer quoi que ce soit —
// une requête falsifiée vers cette URL ne peut donc jamais débloquer un accès.
// --------------------------------------------------------------------------
router.post("/webhook-cinetpay", async (req, res) => {
  try {
    const transactionId = req.body.cpm_trans_id || req.body.transaction_id;
    if (!transactionId) return res.status(400).send("transaction_id manquant");

    const { rows } = await pool.query("SELECT * FROM paiements WHERE reference_externe = $1", [transactionId]);
    const paiement = rows[0];
    if (!paiement) return res.status(404).send("Paiement introuvable");
    if (paiement.statut === "reussi") return res.status(200).send("Déjà traité"); // idempotence

    const statutReel = await verifierTransaction(transactionId);
    if (statutReel.status === "ACCEPTED") {
      await pool.query(
        "UPDATE paiements SET statut = 'reussi', transaction_id_orange = $1, confirme_at = now() WHERE id = $2",
        [statutReel.payment_method || null, paiement.id]
      );
      // Prolonge la date de fin d'utilisation de l'école du nombre de mois payés,
      // à partir d'aujourd'hui OU de la date de fin actuelle si elle n'est pas
      // encore dépassée (pour ne pas faire perdre du temps déjà payé).
      await pool.query(
        `UPDATE ecoles SET date_fin_utilisation =
           GREATEST(COALESCE(date_fin_utilisation, CURRENT_DATE), CURRENT_DATE) + make_interval(months => $1::int)
         WHERE id = $2`,
        [paiement.mois_ajoutes, paiement.ecole_id]
      );
    } else if (statutReel.status === "REFUSED") {
      await pool.query("UPDATE paiements SET statut = 'echoue' WHERE id = $1", [paiement.id]);
    }
    res.status(200).send("OK");
  } catch (err) {
    console.error("Erreur webhook CinetPay :", err.message);
    res.status(500).send("Erreur serveur");
  }
});

// Page de retour simple après le paiement (l'école y est redirigée par CinetPay) —
// le vrai statut est confirmé par le webhook ci-dessus, cette page est juste
// un message d'attente pour l'utilisateur.
router.get("/retour", (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;">
    <h2>Paiement en cours de vérification…</h2>
    <p>Tu peux fermer cette page. Le renouvellement sera visible dans l'application d'ici quelques instants.</p>
  </body></html>`);
});

module.exports = router;
