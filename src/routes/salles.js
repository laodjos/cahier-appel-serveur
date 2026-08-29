const express = require("express");
const { pool } = require("../config/db");
const { authRequired, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);

function ecoleEffective(req) {
  if (req.user.ecole_id) return req.user.ecole_id;
  return req.query?.ecole_id || req.body?.ecole_id || null;
}

// GET /api/salles
router.get("/", async (req, res) => {
  const params = [];
  let filtre = "TRUE";
  const ecoleId = ecoleEffective(req);
  if (ecoleId) { params.push(ecoleId); filtre = `ecole_id = $${params.length}`; }
  const { rows } = await pool.query(`SELECT * FROM salles WHERE ${filtre} ORDER BY nom`, params);
  res.json(rows);
});

// POST /api/salles  { nom, capacite? }
router.post("/", requireRole("direction", "super_admin"), async (req, res) => {
  const { nom, capacite } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: "Le nom de la salle est requis." });
  const ecoleId = ecoleEffective(req);
  if (!ecoleId) return res.status(400).json({ error: "Choisis d'abord une école." });

  try {
    const { rows } = await pool.query(
      "INSERT INTO salles (nom, ecole_id, capacite) VALUES ($1, $2, $3) RETURNING *",
      [nom.trim(), ecoleId, capacite || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Cette salle existe déjà." });
    throw err;
  }
});

// DELETE /api/salles/:id
router.delete("/:id", requireRole("direction", "super_admin"), async (req, res) => {
  await pool.query("DELETE FROM salles WHERE id = $1", [req.params.id]);
  res.status(204).send();
});

module.exports = router;
