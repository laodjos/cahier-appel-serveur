const express = require("express");
const crypto = require("crypto");
const { pool } = require("../config/db");
const { creerLienPaiement } = require("../services/paymentService");
const { calculerSoldeEleve } = require("./fraisScolarite");

const router = express.Router();

// --------------------------------------------------------------------------
// Ces routes sont volontairement PUBLIQUES (aucune authentification) — elles
// sont conçues pour être ouvertes par un parent qui scanne le QR code imprimé
// sur le reçu de son enfant. La protection tient au fait que l'identifiant de
// l'élève (UUID) n'est jamais deviné au hasard — seul quelqu'un ayant le reçu
// physique (ou le lien) peut y accéder. Aucune donnée sensible au-delà du
// solde de scolarité n'est exposée ici (pas de notes, pas d'adresse, etc.).
// --------------------------------------------------------------------------

// GET /api/public/scolarite/:eleveId
router.get("/scolarite/:eleveId", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT s.*, c.nom AS classe_nom, c.niveau FROM students s JOIN classes c ON c.id = s.classe_id WHERE s.id = $1",
    [req.params.eleveId]
  );
  const eleve = rows[0];
  if (!eleve) return res.status(404).json({ error: "Élève introuvable." });
  const solde = await calculerSoldeEleve(eleve);
  res.json({ eleve: { nom: eleve.nom, prenoms: eleve.prenoms, classe_nom: eleve.classe_nom }, ...solde });
});

// POST /api/public/scolarite/:eleveId/payer  { montant }
// Initie un paiement CinetPay pour le solde de scolarité — l'argent ne bouge
// qu'une fois que le parent confirme lui-même sur la page CinetPay avec son
// propre moyen de paiement (Mobile Money ou carte).
router.post("/scolarite/:eleveId/payer", async (req, res) => {
  const { montant, frais_scolarite_id, frais_individuel_id } = req.body;
  if (!montant || Number(montant) <= 0) return res.status(400).json({ error: "Montant invalide." });

  const { rows } = await pool.query("SELECT nom, prenoms FROM students WHERE id = $1", [req.params.eleveId]);
  if (!rows[0]) return res.status(404).json({ error: "Élève introuvable." });

  const referenceExterne = crypto.randomUUID();
  await pool.query(
    `INSERT INTO paiements_scolarite (eleve_id, montant, methode, statut, reference_externe, frais_scolarite_id, frais_individuel_id)
     VALUES ($1, $2, 'cinetpay', 'en_attente', $3, $4, $5)`,
    [req.params.eleveId, montant, referenceExterne, frais_scolarite_id || null, frais_individuel_id || null]
  );

  const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
  try {
    const session = await creerLienPaiement({
      montant,
      transactionId: referenceExterne,
      description: `Scolarité — ${[rows[0].nom, rows[0].prenoms].filter(Boolean).join(" ")}`,
      clientNom: [rows[0].nom, rows[0].prenoms].filter(Boolean).join(" "),
      returnUrl: `${baseUrl}/api/paiements-scolarite/retour`,
      notifyUrl: `${baseUrl}/api/paiements-scolarite/webhook-cinetpay`,
    });
    res.status(201).json({ payment_url: session.payment_url });
  } catch (err) {
    console.error("Échec de création du lien de paiement (portail public) :", err.response?.data || err.message);
    res.status(502).json({ error: "Impossible de créer le lien de paiement pour le moment. Réessaie plus tard." });
  }
});

module.exports = router;
