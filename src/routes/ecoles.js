const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { pool } = require("../config/db");
const { authRequired, requireRole } = require("../middleware/auth");
const { UPLOAD_DIR } = require("../config/uploadDir");

const router = express.Router();
router.use(authRequired);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });

// Dossier où sont stockés logos et cachets — voir src/config/uploadDir.js pour
// le choix de l'emplacement (disque persistant en production).
const DOSSIER_IMAGES_ECOLE = path.join(UPLOAD_DIR, "ecoles");
fs.mkdirSync(DOSSIER_IMAGES_ECOLE, { recursive: true });

function extensionValide(mimetype) {
  if (mimetype === "image/png") return "png";
  if (mimetype === "image/webp") return "webp";
  if (mimetype === "image/jpeg" || mimetype === "image/jpg") return "jpg";
  return null;
}

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
  const { nom, adresse, ville, telephone, annee_scolaire, active, registre_commerce, email } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: "Le nom de l'école est requis." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (active) await client.query("UPDATE ecoles SET active = false");
    const { rows } = await client.query(
      `INSERT INTO ecoles (nom, adresse, ville, telephone, annee_scolaire, active, registre_commerce, email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [nom.trim(), adresse || null, ville || null, telephone || null, annee_scolaire || null, !!active, registre_commerce || null, email || null]
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
  const { nom, adresse, ville, telephone, annee_scolaire, active, registre_commerce, email } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: "Le nom de l'école est requis." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (active) await client.query("UPDATE ecoles SET active = false WHERE id != $1", [req.params.id]);
    const { rows } = await client.query(
      `UPDATE ecoles SET nom=$1, adresse=$2, ville=$3, telephone=$4, annee_scolaire=$5, active=$6, registre_commerce=$7, email=$8 WHERE id=$9 RETURNING *`,
      [nom.trim(), adresse || null, ville || null, telephone || null, annee_scolaire || null, !!active, registre_commerce || null, email || null, req.params.id]
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

// PATCH /api/ecoles/:id/annee-scolaire  { annee_scolaire_id, date_fin_utilisation }
// Réservé au Super-administrateur — assigne l'année scolaire en cours d'un
// établissement et sa date de fin d'utilisation (accès à l'application).
router.patch("/:id/annee-scolaire", requireRole("super_admin"), async (req, res) => {
  const { annee_scolaire_id, date_fin_utilisation } = req.body;
  const { rows } = await pool.query(
    `UPDATE ecoles SET
       annee_scolaire_id = COALESCE($1, annee_scolaire_id),
       date_fin_utilisation = CASE WHEN $2::text IS NOT NULL THEN NULLIF($2, '')::date ELSE date_fin_utilisation END
     WHERE id = $3 RETURNING *`,
    [annee_scolaire_id || null, date_fin_utilisation !== undefined ? date_fin_utilisation : null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "École introuvable." });
  res.json(rows[0]);
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

// POST /api/ecoles/:id/logo — upload/remplacement du logo de l'école (pour les documents imprimés)
router.post("/:id/logo", requireRole("direction", "super_admin"), upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Aucune image reçue (champ \"image\" attendu)." });
  const extension = extensionValide(req.file.mimetype);
  if (!extension) return res.status(400).json({ error: "Format non supporté — utilise une image JPEG, PNG ou WebP." });

  const nomFichier = `logo-${req.params.id}.${extension}`;
  fs.writeFileSync(path.join(DOSSIER_IMAGES_ECOLE, nomFichier), req.file.buffer);
  const url = `/uploads/ecoles/${nomFichier}?v=${Date.now()}`;
  const { rows } = await pool.query("UPDATE ecoles SET logo_url = $1 WHERE id = $2 RETURNING *", [url, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "École introuvable." });
  res.json(rows[0]);
});

// POST /api/ecoles/:id/cachet — upload/remplacement du cachet (tampon) de l'école
router.post("/:id/cachet", requireRole("direction", "super_admin"), upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Aucune image reçue (champ \"image\" attendu)." });
  const extension = extensionValide(req.file.mimetype);
  if (!extension) return res.status(400).json({ error: "Format non supporté — utilise une image JPEG, PNG ou WebP." });

  const nomFichier = `cachet-${req.params.id}.${extension}`;
  fs.writeFileSync(path.join(DOSSIER_IMAGES_ECOLE, nomFichier), req.file.buffer);
  const url = `/uploads/ecoles/${nomFichier}?v=${Date.now()}`;
  const { rows } = await pool.query("UPDATE ecoles SET cachet_url = $1 WHERE id = $2 RETURNING *", [url, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "École introuvable." });
  res.json(rows[0]);
});

module.exports = router;
