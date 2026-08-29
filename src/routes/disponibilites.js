const express = require("express");
const { pool } = require("../config/db");
const { authRequired, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);

// GET /api/disponibilites?user_id=...
router.get("/", async (req, res) => {
  const { user_id } = req.query;
  const params = [];
  let where = "";
  if (user_id) { params.push(user_id); where = "WHERE user_id = $1"; }
  const { rows } = await pool.query(
    `SELECT * FROM disponibilites_enseignants ${where} ORDER BY jour_semaine, heure_debut`,
    params
  );
  res.json(rows);
});

// POST /api/disponibilites  { user_id, jour_semaine, heure_debut, heure_fin }
router.post("/", requireRole("direction", "super_admin"), async (req, res) => {
  const { user_id, jour_semaine, heure_debut, heure_fin } = req.body;
  if (!user_id || !jour_semaine || !heure_debut || !heure_fin) {
    return res.status(400).json({ error: "user_id, jour_semaine, heure_debut et heure_fin sont requis." });
  }
  if (heure_fin <= heure_debut) {
    return res.status(400).json({ error: "L'heure de fin doit être après l'heure de début." });
  }
  const { rows } = await pool.query(
    "INSERT INTO disponibilites_enseignants (user_id, jour_semaine, heure_debut, heure_fin) VALUES ($1,$2,$3,$4) RETURNING *",
    [user_id, jour_semaine, heure_debut, heure_fin]
  );
  res.status(201).json(rows[0]);
});

// DELETE /api/disponibilites/:id
router.delete("/:id", requireRole("direction", "super_admin"), async (req, res) => {
  await pool.query("DELETE FROM disponibilites_enseignants WHERE id = $1", [req.params.id]);
  res.status(204).send();
});

module.exports = router;
