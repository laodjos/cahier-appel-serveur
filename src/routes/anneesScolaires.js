const express = require("express");
const { pool } = require("../config/db");
const { authRequired, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);

// GET /api/annees-scolaires — accessible à tous les comptes connectés (Direction
// doit pouvoir voir la liste pour choisir la sienne, même si seul le
// Super-administrateur peut en créer/supprimer).
router.get("/", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM annees_scolaires ORDER BY date_debut DESC NULLS LAST, libelle DESC");
  res.json(rows);
});

// POST /api/annees-scolaires  { libelle, date_debut, date_fin }
router.post("/", requireRole("super_admin"), async (req, res) => {
  const { libelle, date_debut, date_fin } = req.body;
  if (!libelle || !libelle.trim()) return res.status(400).json({ error: "Le libellé de l'année scolaire est requis (ex. 2025-2026)." });
  if (date_debut && date_fin && date_fin <= date_debut) {
    return res.status(400).json({ error: "La date de fin doit être après la date de début." });
  }
  try {
    const { rows } = await pool.query(
      "INSERT INTO annees_scolaires (libelle, date_debut, date_fin) VALUES ($1, $2, $3) RETURNING *",
      [libelle.trim(), date_debut || null, date_fin || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Cette année scolaire existe déjà." });
    throw err;
  }
});

// DELETE /api/annees-scolaires/:id
router.delete("/:id", requireRole("super_admin"), async (req, res) => {
  await pool.query("DELETE FROM annees_scolaires WHERE id = $1", [req.params.id]);
  res.status(204).send();
});

module.exports = router;
