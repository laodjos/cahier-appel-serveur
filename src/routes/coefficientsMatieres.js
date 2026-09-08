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

// Retrouve le coefficient applicable à une matière pour un élève donné (classe
// précise > niveau > valeur par défaut 1) — utilisé aussi par le calcul de bulletin.
async function trouverCoefficient(matiereId, niveau, classeId) {
  const { rows } = await pool.query(
    `SELECT coefficient FROM coefficients_matieres
     WHERE matiere_id = $1 AND (classe_id = $2 OR (classe_id IS NULL AND niveau = $3))
     ORDER BY classe_id NULLS LAST LIMIT 1`,
    [matiereId, classeId, niveau]
  );
  return rows[0]?.coefficient != null ? Number(rows[0].coefficient) : 1;
}

// GET /api/coefficients-matieres
router.get("/", async (req, res) => {
  const params = [];
  let filtre = "TRUE";
  const ecoleId = ecoleEffective(req);
  if (ecoleId) { params.push(ecoleId); filtre += ` AND cm.ecole_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT cm.*, m.nom AS matiere_nom, cl.nom AS classe_nom FROM coefficients_matieres cm
     JOIN matieres m ON m.id = cm.matiere_id
     LEFT JOIN classes cl ON cl.id = cm.classe_id
     WHERE ${filtre} ORDER BY m.nom`,
    params
  );
  res.json(rows);
});

// POST /api/coefficients-matieres  { matiere_id, niveau?, classe_id?, coefficient }
router.post("/", requireRole("direction", "super_admin"), async (req, res) => {
  const { matiere_id, niveau, classe_id, coefficient } = req.body;
  if (!matiere_id || coefficient == null) return res.status(400).json({ error: "matiere_id et coefficient sont requis." });
  if (!niveau && !classe_id) return res.status(400).json({ error: "Précise un niveau ou une classe pour ce coefficient." });
  const ecoleId = ecoleEffective(req);
  const { rows } = await pool.query(
    `INSERT INTO coefficients_matieres (ecole_id, matiere_id, niveau, classe_id, coefficient)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [ecoleId, matiere_id, classe_id ? null : (niveau || null), classe_id || null, coefficient]
  );
  res.status(201).json(rows[0]);
});

// DELETE /api/coefficients-matieres/:id
router.delete("/:id", requireRole("direction", "super_admin"), async (req, res) => {
  await pool.query("DELETE FROM coefficients_matieres WHERE id = $1", [req.params.id]);
  res.status(204).send();
});

module.exports = router;
module.exports.trouverCoefficient = trouverCoefficient;
