const express = require("express");
const { pool } = require("../config/db");
const { authRequired, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);

// GET /api/ecoles
// Super-admin : voit toutes les écoles. Compte rattaché à une école : ne voit que la sienne.
router.get("/", async (req, res) => {
  if (req.user.role !== "super_admin" && req.user.ecole_id) {
    const { rows } = await pool.query("SELECT * FROM ecoles WHERE id = $1", [req.user.ecole_id]);
    return res.json(rows);
  }
  const { rows } = await pool.query("SELECT * FROM ecoles ORDER BY created_at DESC");
  res.json(rows);
});

// POST /api/ecoles — réservé au Super-administrateur
router.post("/", requireRole("super_admin"), async (req, res) => {
  const { nom, adresse, ville, telephone, annee_scolaire, active } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: "Le nom de l'école est requis." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (active) await client.query("UPDATE ecoles SET active = false");
    const { rows } = await client.query(
      `INSERT INTO ecoles (nom, adresse, ville, telephone, annee_scolaire, active)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [nom.trim(), adresse || null, ville || null, telephone || null, annee_scolaire || null, !!active]
    );
    await client.query("COMMIT");
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// PUT /api/ecoles/:id — réservé au Super-administrateur
router.put("/:id", requireRole("super_admin"), async (req, res) => {
  const { nom, adresse, ville, telephone, annee_scolaire, active } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: "Le nom de l'école est requis." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (active) await client.query("UPDATE ecoles SET active = false WHERE id != $1", [req.params.id]);
    const { rows } = await client.query(
      `UPDATE ecoles SET nom=$1, adresse=$2, ville=$3, telephone=$4, annee_scolaire=$5, active=$6 WHERE id=$7 RETURNING *`,
      [nom.trim(), adresse || null, ville || null, telephone || null, annee_scolaire || null, !!active, req.params.id]
    );
    await client.query("COMMIT");
    if (!rows[0]) return res.status(404).json({ error: "École introuvable." });
    res.json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// DELETE /api/ecoles/:id — réservé au Super-administrateur
router.delete("/:id", requireRole("super_admin"), async (req, res) => {
  await pool.query("DELETE FROM ecoles WHERE id = $1", [req.params.id]);
  res.status(204).send();
});

// POST /api/ecoles/:id/generer-cle-agent — génère (ou régénère) la clé secrète de l'agent local
router.post("/:id/generer-cle-agent", requireRole("direction", "super_admin"), async (req, res) => {
  const crypto = require("crypto");
  const cle = crypto.randomBytes(24).toString("hex");
  const { rows } = await pool.query("UPDATE ecoles SET cle_agent = $1 WHERE id = $2 RETURNING *", [cle, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "École introuvable." });
  res.json(rows[0]);
});

// PATCH /api/ecoles/:id/horaires — modifie les horaires de démarrage des cours.
// Accessible à la Direction, mais UNIQUEMENT pour sa propre école.
router.patch("/:id/horaires", requireRole("direction", "super_admin"), async (req, res) => {
  if (req.user.role === "direction" && req.user.ecole_id !== req.params.id) {
    return res.status(403).json({ error: "Tu ne peux modifier que les horaires de ta propre école." });
  }
  const { heure_debut_matin, heure_fin_matin, heure_debut_apresmidi, heure_fin_apresmidi, heure_debut_recre, heure_fin_recre, heure_debut_recre_apresmidi, heure_fin_recre_apresmidi } = req.body;
  const { rows } = await pool.query(
    `UPDATE ecoles SET
       heure_debut_matin = COALESCE($1, heure_debut_matin),
       heure_fin_matin = COALESCE($2, heure_fin_matin),
       heure_debut_apresmidi = COALESCE($3, heure_debut_apresmidi),
       heure_fin_apresmidi = COALESCE($4, heure_fin_apresmidi),
       heure_debut_recre = COALESCE($5, heure_debut_recre),
       heure_fin_recre = COALESCE($6, heure_fin_recre),
       heure_debut_recre_apresmidi = COALESCE($7, heure_debut_recre_apresmidi),
       heure_fin_recre_apresmidi = COALESCE($8, heure_fin_recre_apresmidi)
     WHERE id = $9 RETURNING *`,
    [heure_debut_matin || null, heure_fin_matin || null, heure_debut_apresmidi || null, heure_fin_apresmidi || null, heure_debut_recre || null, heure_fin_recre || null, heure_debut_recre_apresmidi || null, heure_fin_recre_apresmidi || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "École introuvable." });
  res.json(rows[0]);
});

module.exports = router;
