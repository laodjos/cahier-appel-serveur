const express = require("express");
const { pool } = require("../config/db");
const { authRequiredParent } = require("../middleware/auth");
const { normaliserNumeroCi } = require("../services/notificationService");
const { calculerBulletinsClasseBatch, calculerRangs } = require("./bulletins");
const { calculerSoldeEleve } = require("./fraisScolarite");
const { creerLienPaiement } = require("../services/paymentService");
const crypto = require("crypto");

const router = express.Router();
router.use(authRequiredParent);

// Retrouve les élèves rattachés au parent connecté — en comparant les numéros
// normalisés, pour les mêmes raisons qu'à la connexion (formats de saisie variés).
async function trouverEnfantsDuParent(telephone) {
  const telephoneNorm = normaliserNumeroCi(telephone);
  const { rows: tousLesParents } = await pool.query("SELECT id, telephone FROM parents");
  const idsParent = tousLesParents.filter((p) => normaliserNumeroCi(p.telephone) === telephoneNorm).map((p) => p.id);
  if (idsParent.length === 0) return [];

  const { rows } = await pool.query(
    `SELECT DISTINCT s.id, s.nom, s.prenoms, s.matricule, s.classe_id, c.nom AS classe_nom, c.niveau, c.serie
     FROM students s
     JOIN student_parents sp ON sp.student_id = s.id
     JOIN classes c ON c.id = s.classe_id
     WHERE sp.parent_id = ANY($1::uuid[])
     ORDER BY s.nom`,
    [idsParent]
  );
  return rows;
}

// Vérifie qu'un élève précis appartient bien au parent connecté, avant de lui
// montrer la moindre donnée — un parent ne doit jamais pouvoir consulter un
// autre enfant que le sien en changeant simplement l'identifiant dans l'URL.
async function verifierEnfantDuParent(telephone, eleveId) {
  const enfants = await trouverEnfantsDuParent(telephone);
  return enfants.find((e) => e.id === eleveId) || null;
}

// GET /api/parent-portal/mes-enfants
router.get("/mes-enfants", async (req, res) => {
  const enfants = await trouverEnfantsDuParent(req.parent.telephone);
  res.json(enfants);
});

// GET /api/parent-portal/enfant/:id/presence?debut=&fin=
router.get("/enfant/:id/presence", async (req, res) => {
  const enfant = await verifierEnfantDuParent(req.parent.telephone, req.params.id);
  if (!enfant) return res.status(403).json({ error: "Cet élève n'est pas rattaché à ton compte." });

  const debut = req.query.debut || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const fin = req.query.fin || new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT statut, horodatage FROM attendance_events
     WHERE student_id = $1 AND horodatage::date >= $2 AND horodatage::date <= $3
     ORDER BY horodatage DESC`,
    [enfant.id, debut, fin]
  );
  res.json(rows);
});

// GET /api/parent-portal/enfant/:id/periodes
router.get("/enfant/:id/periodes", async (req, res) => {
  const enfant = await verifierEnfantDuParent(req.parent.telephone, req.params.id);
  if (!enfant) return res.status(403).json({ error: "Cet élève n'est pas rattaché à ton compte." });
  const { rows } = await pool.query(
    "SELECT id, nom FROM periodes_evaluation WHERE ecole_id = (SELECT ecole_id FROM classes WHERE id = $1) ORDER BY ordre",
    [enfant.classe_id]
  );
  res.json(rows);
});

// GET /api/parent-portal/enfant/:id/bulletin?periode_id=
router.get("/enfant/:id/bulletin", async (req, res) => {
  const enfant = await verifierEnfantDuParent(req.parent.telephone, req.params.id);
  if (!enfant) return res.status(403).json({ error: "Cet élève n'est pas rattaché à ton compte." });
  const { periode_id } = req.query;
  if (!periode_id) return res.status(400).json({ error: "periode_id est requis." });

  try {
  const bulletinsClasse = await calculerBulletinsClasseBatch(enfant.classe_id, periode_id, enfant.niveau, enfant.serie);
  const vide = { details: [], moyenne_generale: null };
  const bulletin = bulletinsClasse[enfant.id] || vide;

  const { rows: elevesClasse } = await pool.query("SELECT id FROM students WHERE classe_id = $1", [enfant.classe_id]);
  const resultatsClasse = elevesClasse.map((e) => ({ eleve_id: e.id, moyenne_generale: (bulletinsClasse[e.id] || vide).moyenne_generale }));
  calculerRangs(resultatsClasse);
  const rang = resultatsClasse.find((r) => r.eleve_id === enfant.id)?.rang ?? null;

  res.json({ ...bulletin, rang, effectif_classe: elevesClasse.length });
  } catch (err) {
    console.error("Erreur bulletin espace parent :", err);
    res.status(500).json({ error: "Impossible de charger le bulletin pour le moment." });
  }
});

// GET /api/parent-portal/enfant/:id/notes-detail?periode_id= — chaque note
// individuelle (pas seulement la moyenne), pour suivre l'évolution devoir par
// devoir plutôt qu'un seul chiffre final.
router.get("/enfant/:id/notes-detail", async (req, res) => {
  const enfant = await verifierEnfantDuParent(req.parent.telephone, req.params.id);
  if (!enfant) return res.status(403).json({ error: "Cet élève n'est pas rattaché à ton compte." });
  const { periode_id } = req.query;
  if (!periode_id) return res.status(400).json({ error: "periode_id est requis." });

  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.valeur, n.note_sur, n.type_evaluation, n.est_moyenne_directe, n.created_at, m.nom AS matiere_nom
       FROM notes n JOIN matieres m ON m.id = n.matiere_id
       WHERE n.eleve_id = $1 AND n.periode_id = $2
       ORDER BY m.nom, n.created_at`,
      [enfant.id, periode_id]
    );
    res.json(rows);
  } catch (err) {
    console.error("Erreur détail des notes espace parent :", err);
    res.status(500).json({ error: "Impossible de charger le détail des notes pour le moment." });
  }
});

// GET /api/parent-portal/enfant/:id/scolarite
router.get("/enfant/:id/scolarite", async (req, res) => {
  const enfant = await verifierEnfantDuParent(req.parent.telephone, req.params.id);
  if (!enfant) return res.status(403).json({ error: "Cet élève n'est pas rattaché à ton compte." });
  const solde = await calculerSoldeEleve(enfant);
  res.json(solde);
});

// POST /api/parent-portal/enfant/:id/payer  { montant }
router.post("/enfant/:id/payer", async (req, res) => {
  const enfant = await verifierEnfantDuParent(req.parent.telephone, req.params.id);
  if (!enfant) return res.status(403).json({ error: "Cet élève n'est pas rattaché à ton compte." });
  const { montant, frais_scolarite_id, frais_individuel_id } = req.body;
  if (!montant || Number(montant) <= 0) return res.status(400).json({ error: "Montant invalide." });

  const referenceExterne = crypto.randomUUID();
  await pool.query(
    `INSERT INTO paiements_scolarite (eleve_id, montant, methode, statut, reference_externe, frais_scolarite_id, frais_individuel_id)
     VALUES ($1, $2, 'cinetpay', 'en_attente', $3, $4, $5)`,
    [enfant.id, montant, referenceExterne, frais_scolarite_id || null, frais_individuel_id || null]
  );

  const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
  try {
    const session = await creerLienPaiement({
      montant,
      transactionId: referenceExterne,
      description: `Scolarité — ${enfant.nom} ${enfant.prenoms || ""}`.trim(),
      clientNom: `${enfant.nom} ${enfant.prenoms || ""}`.trim(),
      returnUrl: `${baseUrl}/api/paiements-scolarite/retour`,
      notifyUrl: `${baseUrl}/api/paiements-scolarite/webhook-cinetpay`,
    });
    res.status(201).json({ payment_url: session.payment_url });
  } catch (err) {
    console.error("Échec de création du lien de paiement (espace parent) :", err.response?.data || err.message);
    res.status(502).json({ error: "Impossible de créer le lien de paiement pour le moment." });
  }
});

module.exports = router;
