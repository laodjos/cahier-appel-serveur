const express = require("express");
const crypto = require("crypto");
const { pool } = require("../config/db");
const { authRequired, requireRole, requireErpActif } = require("../middleware/auth");
const { creerLienPaiement, verifierTransaction } = require("../services/paymentService");
const { programmerNotificationPaiement } = require("../services/notificationService");
const { calculerSoldeEleve } = require("./fraisScolarite");

const router = express.Router();

function ecoleEffective(req) {
  if (req.user.ecole_id) return req.user.ecole_id;
  return req.query?.ecole_id || req.body?.ecole_id || null;
}

// GET /api/paiements-scolarite?eleve_id=... — historique d'un élève précis
// GET /api/paiements-scolarite?debut=&fin=&classe_id= — TOUS les paiements de
// l'école (pour la vue d'ensemble et la réimpression de reçus), avec filtres
// optionnels de période et de classe.
router.get("/", authRequired, requireErpActif, async (req, res) => {
  const { eleve_id, debut, fin, classe_id } = req.query;
  const params = [];
  let filtre = "TRUE";

  if (eleve_id) {
    params.push(eleve_id); filtre += ` AND ps.eleve_id = $${params.length}`;
  } else {
    const ecoleId = ecoleEffective(req);
    if (!ecoleId) return res.status(400).json({ error: "Choisis d'abord une école." });
    params.push(ecoleId); filtre += ` AND c.ecole_id = $${params.length}`;
  }
  if (classe_id) { params.push(classe_id); filtre += ` AND s.classe_id = $${params.length}`; }
  if (debut) { params.push(debut); filtre += ` AND ps.created_at::date >= $${params.length}`; }
  if (fin) { params.push(fin); filtre += ` AND ps.created_at::date <= $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT ps.*, COALESCE(fs.libelle, fi.libelle) AS frais_libelle, ca.nom AS caisse_nom,
            s.nom AS eleve_nom, s.prenoms AS eleve_prenoms, c.nom AS classe_nom
     FROM paiements_scolarite ps
     LEFT JOIN frais_scolarite fs ON fs.id = ps.frais_scolarite_id
     LEFT JOIN frais_individuels fi ON fi.id = ps.frais_individuel_id
     LEFT JOIN caisses ca ON ca.id = ps.caisse_id
     LEFT JOIN students s ON s.id = ps.eleve_id
     LEFT JOIN classes c ON c.id = s.classe_id
     WHERE ${filtre} ORDER BY ps.created_at DESC LIMIT 300`, params
  );
  res.json(rows);
});

// POST /api/paiements-scolarite/manuel  { eleve_id, montant }
// Enregistre un paiement reçu en espèces (ou tout autre moyen géré hors ligne),
// saisi directement par l'administration.
router.post("/manuel", authRequired, requireErpActif, requireRole("direction", "super_admin", "caissier"), async (req, res) => {
  const { eleve_id, montant, caisse_id, frais_scolarite_id, frais_individuel_id } = req.body;
  if (!eleve_id || !montant || Number(montant) <= 0) return res.status(400).json({ error: "eleve_id et montant (positif) sont requis." });
  const { rows } = await pool.query(
    `INSERT INTO paiements_scolarite (eleve_id, montant, methode, statut, saisi_par, caisse_id, frais_scolarite_id, frais_individuel_id, confirme_at)
     VALUES ($1, $2, 'especes', 'reussi', $3, $4, $5, $6, now()) RETURNING *`,
    [eleve_id, montant, req.user.sub, caisse_id || null, frais_scolarite_id || null, frais_individuel_id || null]
  );
  try {
    const { rows: eleveRows } = await pool.query(
      "SELECT s.*, c.niveau, c.ecole_id FROM students s JOIN classes c ON c.id = s.classe_id WHERE s.id = $1", [eleve_id]
    );
    if (eleveRows[0]) {
      const solde = await calculerSoldeEleve(eleveRows[0]);
      await programmerNotificationPaiement(eleve_id, montant, Math.max(0, solde.solde ?? 0));
    }
  } catch (err) {
    console.error("Notification de paiement non envoyée (paiement déjà enregistré) :", err.message);
  }
  res.status(201).json(rows[0]);
});

// POST /api/paiements-scolarite/initier  { eleve_id, montant }
// Génère un lien de paiement CinetPay pour la scolarité d'un élève (à
// transmettre au parent — SMS, WhatsApp...).
router.post("/initier", authRequired, requireErpActif, requireRole("direction", "super_admin", "caissier"), async (req, res) => {
  const { eleve_id, montant } = req.body;
  if (!eleve_id || !montant || Number(montant) <= 0) return res.status(400).json({ error: "eleve_id et montant (positif) sont requis." });

  const { rows: eleveRows } = await pool.query("SELECT nom, prenoms FROM students WHERE id = $1", [eleve_id]);
  if (!eleveRows[0]) return res.status(404).json({ error: "Élève introuvable." });

  const referenceExterne = crypto.randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO paiements_scolarite (eleve_id, montant, methode, statut, reference_externe, saisi_par)
     VALUES ($1, $2, 'cinetpay', 'en_attente', $3, $4) RETURNING *`,
    [eleve_id, montant, referenceExterne, req.user.sub]
  );

  const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
  try {
    const session = await creerLienPaiement({
      montant,
      transactionId: referenceExterne,
      description: `Scolarité — ${[eleveRows[0].nom, eleveRows[0].prenoms].filter(Boolean).join(" ")}`,
      clientNom: [eleveRows[0].nom, eleveRows[0].prenoms].filter(Boolean).join(" "),
      returnUrl: `${baseUrl}/api/paiements-scolarite/retour`,
      notifyUrl: `${baseUrl}/api/paiements-scolarite/webhook-cinetpay`,
    });
    res.status(201).json({ paiement: rows[0], payment_url: session.payment_url });
  } catch (err) {
    await pool.query("UPDATE paiements_scolarite SET statut = 'echoue' WHERE id = $1", [rows[0].id]);
    console.error("Échec de création du lien de paiement scolarité :", err.response?.data || err.message);
    res.status(502).json({ error: "Impossible de créer le lien de paiement CinetPay." });
  }
});

// --------------------------------------------------------------------------
// POST /api/paiements-scolarite/webhook-cinetpay — même principe de sécurité
// que pour les paiements de renouvellement d'abonnement : on revérifie
// systématiquement le vrai statut auprès de CinetPay avant de créditer quoi
// que ce soit, jamais sur la seule foi du contenu de cette requête.
// --------------------------------------------------------------------------
router.post("/webhook-cinetpay", async (req, res) => {
  try {
    const transactionId = req.body.cpm_trans_id || req.body.transaction_id;
    if (!transactionId) return res.status(400).send("transaction_id manquant");

    const { rows } = await pool.query("SELECT * FROM paiements_scolarite WHERE reference_externe = $1", [transactionId]);
    const paiement = rows[0];
    if (!paiement) return res.status(404).send("Paiement introuvable");
    if (paiement.statut === "reussi") return res.status(200).send("Déjà traité");

    const statutReel = await verifierTransaction(transactionId);
    if (statutReel.status === "ACCEPTED") {
      await pool.query("UPDATE paiements_scolarite SET statut = 'reussi', confirme_at = now() WHERE id = $1", [paiement.id]);
      try {
        const { rows: eleveRows } = await pool.query(
          "SELECT s.*, c.niveau, c.ecole_id FROM students s JOIN classes c ON c.id = s.classe_id WHERE s.id = $1", [paiement.eleve_id]
        );
        if (eleveRows[0]) {
          const solde = await calculerSoldeEleve(eleveRows[0]);
          await programmerNotificationPaiement(paiement.eleve_id, paiement.montant, Math.max(0, solde.solde ?? 0));
        }
      } catch (errNotif) {
        console.error("Notification de paiement en ligne non envoyée :", errNotif.message);
      }
    } else if (statutReel.status === "REFUSED") {
      await pool.query("UPDATE paiements_scolarite SET statut = 'echoue' WHERE id = $1", [paiement.id]);
    }
    res.status(200).send("OK");
  } catch (err) {
    console.error("Erreur webhook paiement scolarité :", err.message);
    res.status(500).send("Erreur serveur");
  }
});

router.get("/retour", (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;">
    <h2>Paiement en cours de vérification…</h2>
    <p>Tu peux fermer cette page. Le solde de scolarité sera mis à jour d'ici quelques instants.</p>
  </body></html>`);
});

module.exports = router;
