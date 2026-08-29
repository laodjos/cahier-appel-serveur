const express = require("express");
const { pool } = require("../config/db");
const { authRequired, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);

function ecoleEffective(req) {
  if (req.user.ecole_id) return req.user.ecole_id;
  return req.query?.ecole_id || req.body?.ecole_id || null;
}

// GET /api/matieres
router.get("/", async (req, res) => {
  const params = [];
  let filtre = "TRUE";
  const ecoleId = ecoleEffective(req);
  if (ecoleId) { params.push(ecoleId); filtre = `ecole_id = $${params.length}`; }
  const { rows } = await pool.query(`SELECT * FROM matieres WHERE ${filtre} ORDER BY nom`, params);
  res.json(rows);
});

// POST /api/matieres  { nom }
router.post("/", requireRole("direction", "super_admin"), async (req, res) => {
  const { nom } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: "Le nom de la matière est requis." });
  const ecoleId = ecoleEffective(req);
  if (!ecoleId) return res.status(400).json({ error: "Choisis d'abord une école." });

  try {
    const { rows } = await pool.query(
      "INSERT INTO matieres (nom, ecole_id) VALUES ($1, $2) RETURNING *",
      [nom.trim(), ecoleId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Cette matière existe déjà." });
    throw err;
  }
});

// DELETE /api/matieres/:id
router.delete("/:id", requireRole("direction", "super_admin"), async (req, res) => {
  await pool.query("DELETE FROM matieres WHERE id = $1", [req.params.id]);
  res.status(204).send();
});

module.exports = router;
