const express = require("express");
const { pool } = require("../config/db");
const { authRequired, requireRole, requireErpActif } = require("../middleware/auth");

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
async function calculerSoldeEleve(eleve) {
  const { rows: fraisRows } = await pool.query(
    `SELECT * FROM frais_scolarite WHERE (classe_id = $1 OR (classe_id IS NULL AND niveau = $2))
     ORDER BY classe_id NULLS LAST LIMIT 1`,
    [eleve.classe_id, eleve.niveau]
  );
  const frais = fraisRows[0] || null;
  const { rows: paiements } = await pool.query(
    "SELECT montant FROM paiements_scolarite WHERE eleve_id = $1 AND statut = 'reussi'", [eleve.id]
  );
  const montantPaye = paiements.reduce((s, p) => s + Number(p.montant), 0);
  const montantTotal = frais ? Number(frais.montant_total) : null;
  const solde = montantTotal != null ? montantTotal - montantPaye : null;
  return { frais_id: frais?.id || null, libelle: frais?.libelle || null, montant_total: montantTotal, montant_paye: montantPaye, solde, a_jour: solde != null ? solde <= 0 : null };
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
  const { niveau, classe_id, libelle, montant_total, annee_scolaire_id } = req.body;
  if (!montant_total || (!niveau && !classe_id)) {
    return res.status(400).json({ error: "montant_total et (niveau ou classe_id) sont requis." });
  }
  const ecoleId = ecoleEffective(req);
  const { rows } = await pool.query(
    `INSERT INTO frais_scolarite (ecole_id, annee_scolaire_id, niveau, classe_id, libelle, montant_total)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [ecoleId, annee_scolaire_id || null, classe_id ? null : (niveau || null), classe_id || null, libelle || "Frais de scolarité", montant_total]
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
  res.json({ eleve: { id: eleve.id, nom: eleve.nom }, ...solde });
});

// GET /api/frais-scolarite/solde-classe/:classeId — vue d'ensemble d'une classe
router.get("/solde-classe/:classeId", async (req, res) => {
  const { rows: classeRows } = await pool.query("SELECT * FROM classes WHERE id = $1", [req.params.classeId]);
  const classe = classeRows[0];
  if (!classe) return res.status(404).json({ error: "Classe introuvable." });
  const { rows: eleves } = await pool.query("SELECT id, nom FROM students WHERE classe_id = $1 ORDER BY nom", [classe.id]);
  const resultats = [];
  for (const e of eleves) {
    const solde = await calculerSoldeEleve({ ...e, classe_id: classe.id, niveau: classe.niveau });
    resultats.push({ eleve: { id: e.id, nom: e.nom }, ...solde });
  }
  res.json({ classe: { id: classe.id, nom: classe.nom }, eleves: resultats });
});

module.exports = router;
module.exports.calculerSoldeEleve = calculerSoldeEleve;
