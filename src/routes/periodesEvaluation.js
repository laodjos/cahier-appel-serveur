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

// GET /api/periodes-evaluation?annee_scolaire_id=...
router.get("/", async (req, res) => {
  const params = [];
  let filtre = "TRUE";
  const ecoleId = ecoleEffective(req);
  if (ecoleId) { params.push(ecoleId); filtre += ` AND ecole_id = $${params.length}`; }
  if (req.query.annee_scolaire_id) { params.push(req.query.annee_scolaire_id); filtre += ` AND annee_scolaire_id = $${params.length}`; }
  const { rows } = await pool.query(`SELECT * FROM periodes_evaluation WHERE ${filtre} ORDER BY ordre`, params);
  res.json(rows);
});

// POST /api/periodes-evaluation  { nom, ordre, date_debut, date_fin, annee_scolaire_id }
router.post("/", requireRole("direction", "super_admin"), async (req, res) => {
  const { nom, ordre, date_debut, date_fin, annee_scolaire_id } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: "Le nom de la période est requis." });
  const ecoleId = ecoleEffective(req);
  const { rows } = await pool.query(
    `INSERT INTO periodes_evaluation (ecole_id, annee_scolaire_id, nom, ordre, date_debut, date_fin)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [ecoleId, annee_scolaire_id || null, nom.trim(), ordre || 1, date_debut || null, date_fin || null]
  );
  res.status(201).json(rows[0]);
});

// DELETE /api/periodes-evaluation/:id
router.delete("/:id", requireRole("direction", "super_admin"), async (req, res) => {
  await pool.query("DELETE FROM periodes_evaluation WHERE id = $1", [req.params.id]);
  res.status(204).send();
});

// PATCH /api/periodes-evaluation/:id/saisie  { saisie_ouverte }
// Ouvre ou ferme la saisie des notes pour cette période — seule la Direction
// ou le Super-administrateur peut faire cette bascule.
router.patch("/:id/saisie", requireRole("direction", "super_admin"), async (req, res) => {
  const { saisie_ouverte } = req.body;
  const { rows } = await pool.query(
    "UPDATE periodes_evaluation SET saisie_ouverte = $1 WHERE id = $2 RETURNING *",
    [!!saisie_ouverte, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Période introuvable." });
  res.json(rows[0]);
});

module.exports = router;
