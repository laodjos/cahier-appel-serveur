const express = require("express");
const { pool } = require("../config/db");
const { authRequired, requireRole, requireErpActif } = require("../middleware/auth");
const { genererImageQr } = require("../services/qrService");

const router = express.Router();
router.use(authRequired);
router.use(requireErpActif);

function ecoleEffective(req) {
  if (req.user.ecole_id) return req.user.ecole_id;
  return req.query?.ecole_id || req.body?.ecole_id || null;
}

// Retrouve le montant de scolarité applicable à un élève (classe précise en
// priorité, sinon le niveau de sa classe), et calcule son solde à partir des
// paiements déjà confirmés — les paiements "en_attente" ne comptent jamais
// tant qu'ils ne sont pas confirmés côté serveur (voir webhook CinetPay).
// Retrouve TOUS les frais applicables à un élève (classe précise et/ou tous
// ceux du niveau, filtrés selon son statut d'affectation) et les additionne
// avec ses éventuels frais individuels (ex. un reliquat impayé de l'année
// précédente) — chacun suivi séparément dans le détail, réglés contre un
// solde total unique.
async function calculerSoldeEleve(eleve) {
  const { rows: fraisRows } = await pool.query(
    `SELECT * FROM frais_scolarite
     WHERE (classe_id = $1 OR (classe_id IS NULL AND niveau = $2))
       AND (applicable_a = 'tous' OR applicable_a = $3)
     ORDER BY libelle`,
    [eleve.classe_id, eleve.niveau, eleve.affecte ? "affecte" : "non_affecte"]
  );
  const { rows: fraisIndivRows } = await pool.query(
    "SELECT * FROM frais_individuels WHERE eleve_id = $1 ORDER BY est_reliquat DESC, created_at", [eleve.id]
  );
  const { rows: paiements } = await pool.query(
    "SELECT montant FROM paiements_scolarite WHERE eleve_id = $1 AND statut = 'reussi'", [eleve.id]
  );
  // Le reliquat passe systématiquement en tête du détail — il doit se
  // régler en priorité, avant même les frais de la nouvelle inscription.
  const detailReliquat = fraisIndivRows.filter((f) => f.est_reliquat).map((f) => ({ id: f.id, libelle: f.libelle, montant: Number(f.montant), individuel: true, est_reliquat: true }));
  const detailAutres = [
    ...fraisRows.map((f) => ({ id: f.id, libelle: f.libelle, montant: Number(f.montant_total) })),
    ...fraisIndivRows.filter((f) => !f.est_reliquat).map((f) => ({ id: f.id, libelle: f.libelle, montant: Number(f.montant), individuel: true })),
  ];
  const detail = [...detailReliquat, ...detailAutres];
  const montantPaye = paiements.reduce((s, p) => s + Number(p.montant), 0);
  const montantTotal = detail.length > 0 ? detail.reduce((s, f) => s + Number(f.montant), 0) : null;
  const solde = montantTotal != null ? montantTotal - montantPaye : null;
  return {
    detail,
    montant_total: montantTotal, montant_paye: montantPaye, solde,
    a_jour: solde != null ? solde <= 0 : null,
    // Signale spécifiquement un reliquat encore impayé, pour l'afficher en
    // alerte avant de traiter une nouvelle inscription.
    reliquat_impaye: detailReliquat.length > 0 && solde != null && solde > 0,
  };
}

// GET /api/frais-scolarite
router.get("/", async (req, res) => {
  const params = [];
  let filtre = "TRUE";
  const ecoleId = ecoleEffective(req);
  if (ecoleId) { params.push(ecoleId); filtre += ` AND fs.ecole_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT fs.*, cl.nom AS classe_nom FROM frais_scolarite fs LEFT JOIN classes cl ON cl.id = fs.classe_id WHERE ${filtre} ORDER BY fs.niveau`,
    params
  );
  res.json(rows);
});

// POST /api/frais-scolarite  { niveau?, classe_id?, libelle, montant_total, annee_scolaire_id? }
router.post("/", requireRole("direction", "super_admin"), async (req, res) => {
  const { niveau, classe_id, libelle, montant_total, annee_scolaire_id, applicable_a } = req.body;
  if (!montant_total || (!niveau && !classe_id)) {
    return res.status(400).json({ error: "montant_total et (niveau ou classe_id) sont requis." });
  }
  if (applicable_a && !["tous", "affecte", "non_affecte"].includes(applicable_a)) {
    return res.status(400).json({ error: "applicable_a invalide." });
  }
  const ecoleId = ecoleEffective(req);
  const { rows } = await pool.query(
    `INSERT INTO frais_scolarite (ecole_id, annee_scolaire_id, niveau, classe_id, libelle, montant_total, applicable_a)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [ecoleId, annee_scolaire_id || null, classe_id ? null : (niveau || null), classe_id || null, libelle || "Frais de scolarité", montant_total, applicable_a || "tous"]
  );
  res.status(201).json(rows[0]);
});

// DELETE /api/frais-scolarite/:id
router.delete("/:id", requireRole("direction", "super_admin"), async (req, res) => {
  await pool.query("DELETE FROM frais_scolarite WHERE id = $1", [req.params.id]);
  res.status(204).send();
});

// GET /api/frais-scolarite/solde/:eleveId
router.get("/solde/:eleveId", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT s.*, c.niveau FROM students s JOIN classes c ON c.id = s.classe_id WHERE s.id = $1", [req.params.eleveId]
  );
  const eleve = rows[0];
  if (!eleve) return res.status(404).json({ error: "Élève introuvable." });
  const solde = await calculerSoldeEleve(eleve);
  res.json({ eleve: { id: eleve.id, nom: eleve.nom, prenoms: eleve.prenoms }, ...solde });
});

// GET /api/frais-scolarite/solde-classe/:classeId — vue d'ensemble d'une classe
// Version optimisée : nombre de requêtes fixe (peu importe le nombre d'élèves),
// au lieu d'une par élève — même correction de fond que pour les bulletins de
// classe, qui pouvait provoquer un délai excessif (voire une erreur 502) sur
// une classe chargée. Le détail se calcule par élève (pas un total partagé)
// car chacun peut avoir un statut d'affectation et des frais individuels
// (ex. reliquat) différents.
router.get("/solde-classe/:classeId", async (req, res) => {
  try {
  const { rows: classeRows } = await pool.query("SELECT * FROM classes WHERE id = $1", [req.params.classeId]);
  const classe = classeRows[0];
  if (!classe) return res.status(404).json({ error: "Classe introuvable." });

  const { rows: eleves } = await pool.query("SELECT id, nom, prenoms, affecte FROM students WHERE classe_id = $1 ORDER BY nom", [classe.id]);
  const eleveIds = eleves.map((e) => e.id);

  // Tous les frais du niveau (toutes affectations confondues — on filtre par
  // élève ensuite), tous les frais individuels de la classe, et tous les
  // paiements — en 3 requêtes fixes, peu importe l'effectif.
  const { rows: fraisRows } = await pool.query(
    "SELECT * FROM frais_scolarite WHERE classe_id = $1 OR (classe_id IS NULL AND niveau = $2) ORDER BY libelle",
    [classe.id, classe.niveau]
  );
  const { rows: fraisIndivRows } = await pool.query(
    "SELECT * FROM frais_individuels WHERE eleve_id = ANY($1::uuid[]) ORDER BY created_at", [eleveIds]
  );
  const { rows: paiements } = await pool.query(
    "SELECT eleve_id, montant FROM paiements_scolarite WHERE eleve_id = ANY($1::uuid[]) AND statut = 'reussi'",
    [eleveIds]
  );
  const payeParEleve = {};
  for (const p of paiements) {
    payeParEleve[p.eleve_id] = (payeParEleve[p.eleve_id] || 0) + Number(p.montant);
  }
  const indivParEleve = {};
  for (const f of fraisIndivRows) {
    (indivParEleve[f.eleve_id] = indivParEleve[f.eleve_id] || []).push(f);
  }

  const resultats = eleves.map((e) => {
    const fraisApplicables = fraisRows.filter((f) => f.applicable_a === "tous" || f.applicable_a === (e.affecte ? "affecte" : "non_affecte"));
    const individuelsEleve = indivParEleve[e.id] || [];
    const detailReliquat = individuelsEleve.filter((f) => f.est_reliquat).map((f) => ({ id: f.id, libelle: f.libelle, montant: Number(f.montant), individuel: true, est_reliquat: true }));
    const detailAutres = [
      ...fraisApplicables.map((f) => ({ id: f.id, libelle: f.libelle, montant: Number(f.montant_total) })),
      ...individuelsEleve.filter((f) => !f.est_reliquat).map((f) => ({ id: f.id, libelle: f.libelle, montant: Number(f.montant), individuel: true })),
    ];
    const detail = [...detailReliquat, ...detailAutres];
    const montantTotal = detail.length > 0 ? detail.reduce((s, f) => s + Number(f.montant), 0) : null;
    const montantPaye = payeParEleve[e.id] || 0;
    const solde = montantTotal != null ? montantTotal - montantPaye : null;
    return {
      eleve: { id: e.id, nom: e.nom, prenoms: e.prenoms },
      detail,
      montant_total: montantTotal, montant_paye: montantPaye, solde,
      a_jour: solde != null ? solde <= 0 : null,
      reliquat_impaye: detailReliquat.length > 0 && solde != null && solde > 0,
    };
  });
  res.json({ classe: { id: classe.id, nom: classe.nom }, eleves: resultats });
  } catch (err) {
    console.error("Erreur solde-classe :", err);
    res.status(500).json({ error: "Impossible de calculer le solde de la classe pour le moment." });
  }
});

// GET /api/frais-scolarite/:eleveId/qr-portail — QR code encodant le lien vers
// le portail public de consultation/paiement du solde, à imprimer sur le reçu.
router.get("/:eleveId/qr-portail", async (req, res) => {
  const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const lienPortail = `${baseUrl}/portail-scolarite.html?eleve=${req.params.eleveId}`;
  const image = await genererImageQr(lienPortail);
  res.json({ image, lien: lienPortail });
});

// --------------------------------------------------------------------------
// Frais individuels — propres à un élève précis (ex. reliquat impayé de
// l'année précédente), plutôt qu'à tout un niveau.
// --------------------------------------------------------------------------

// GET /api/frais-scolarite/individuels/:eleveId
router.get("/individuels/:eleveId", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM frais_individuels WHERE eleve_id = $1 ORDER BY created_at", [req.params.eleveId]
  );
  res.json(rows);
});

// POST /api/frais-scolarite/individuels  { eleve_id, libelle, montant, est_reliquat? }
router.post("/individuels", requireRole("direction", "super_admin"), async (req, res) => {
  const { eleve_id, libelle, montant, est_reliquat } = req.body;
  if (!eleve_id || !libelle || !libelle.trim() || !montant || Number(montant) <= 0) {
    return res.status(400).json({ error: "eleve_id, libelle et montant (positif) sont requis." });
  }
  const { rows } = await pool.query(
    "INSERT INTO frais_individuels (eleve_id, libelle, montant, est_reliquat, saisi_par) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [eleve_id, libelle.trim(), montant, !!est_reliquat, req.user.sub]
  );
  res.status(201).json(rows[0]);
});

// DELETE /api/frais-scolarite/individuels/:id
router.delete("/individuels/:id", requireRole("direction", "super_admin"), async (req, res) => {
  await pool.query("DELETE FROM frais_individuels WHERE id = $1", [req.params.id]);
  res.status(204).send();
});

module.exports = router;
module.exports.calculerSoldeEleve = calculerSoldeEleve;
