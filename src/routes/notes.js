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

// Vérifie qu'un enseignant est bien rattaché à cette classe ET enseigne bien
// cette matière — sans ce contrôle, n'importe quel enseignant pourrait saisir
// des notes pour une classe ou une matière qui n'est pas la sienne (même
// principe que le contrôle déjà appliqué à l'appel de présence).
async function enseignantAutorise(userId, classeId, matiereId) {
  const { rows: rattache } = await pool.query(
    "SELECT 1 FROM enseignant_classes WHERE user_id = $1 AND classe_id = $2", [userId, classeId]
  );
  if (!rattache[0]) return false;
  const { rows: userRows } = await pool.query("SELECT matieres FROM users WHERE id = $1", [userId]);
  const { rows: matiereRows } = await pool.query("SELECT nom FROM matieres WHERE id = $1", [matiereId]);
  const matieresEnseignant = (userRows[0]?.matieres || "").split(",").map((m) => m.trim());
  return matieresEnseignant.includes(matiereRows[0]?.nom);
}

// La saisie des notes doit avoir été explicitement ouverte par la Direction ou
// le Super-administrateur pour la période concernée — fermée par défaut à la
// création d'une période. Direction/Super-admin restent toujours autorisés à
// saisir/corriger, même période fermée (c'est justement eux qui la gèrent).
async function saisieAutoriseePourRole(role, periodeId) {
  if (role !== "enseignant") return true;
  const { rows } = await pool.query("SELECT saisie_ouverte FROM periodes_evaluation WHERE id = $1", [periodeId]);
  return !!rows[0]?.saisie_ouverte;
}

// GET /api/notes?classe_id=&matiere_id=&periode_id=
router.get("/", async (req, res) => {
  try {
  const { classe_id, matiere_id, periode_id } = req.query;
  const params = [];
  let filtre = "TRUE";
  if (classe_id) { params.push(classe_id); filtre += ` AND n.classe_id = $${params.length}`; }
  if (matiere_id) { params.push(matiere_id); filtre += ` AND n.matiere_id = $${params.length}`; }
  if (periode_id) { params.push(periode_id); filtre += ` AND n.periode_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT n.* FROM notes n WHERE ${filtre} ORDER BY n.created_at`, params
  );
  res.json(rows);
  } catch (err) {
    console.error("Erreur GET /notes :", err);
    res.status(500).json({ error: "Impossible de charger les notes pour le moment." });
  }
});

// POST /api/notes  { eleve_id, matiere_id, periode_id, classe_id, valeur, note_sur, type_evaluation }
router.post("/", async (req, res) => {
  const { eleve_id, matiere_id, periode_id, classe_id, valeur, note_sur, type_evaluation } = req.body;
  if (!eleve_id || !matiere_id || !periode_id || !classe_id || valeur == null) {
    return res.status(400).json({ error: "eleve_id, matiere_id, periode_id, classe_id et valeur sont requis." });
  }
  const noteSur = note_sur || 20;
  if (Number(valeur) < 0 || Number(valeur) > Number(noteSur)) {
    return res.status(400).json({ error: `La note doit être comprise entre 0 et ${noteSur}.` });
  }
  if (req.user.role === "enseignant" && !(await enseignantAutorise(req.user.sub, classe_id, matiere_id))) {
    return res.status(403).json({ error: "Tu n'es pas rattaché à cette classe pour cette matière — impossible de saisir cette note." });
  }
  if (!(await saisieAutoriseePourRole(req.user.role, periode_id))) {
    return res.status(403).json({ error: "La saisie des notes est actuellement fermée pour cette période — contacte la Direction pour qu'elle l'ouvre." });
  }
  const { rows } = await pool.query(
    `INSERT INTO notes (eleve_id, matiere_id, periode_id, classe_id, valeur, note_sur, type_evaluation, saisi_par)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [eleve_id, matiere_id, periode_id, classe_id, valeur, noteSur, type_evaluation || "devoir", req.user.sub]
  );
  res.status(201).json(rows[0]);
});

// PATCH /api/notes/:id  { valeur }
router.patch("/:id", async (req, res) => {
  const { valeur } = req.body;
  const { rows: existante } = await pool.query("SELECT * FROM notes WHERE id = $1", [req.params.id]);
  if (!existante[0]) return res.status(404).json({ error: "Note introuvable." });
  if (req.user.role === "enseignant" && !(await enseignantAutorise(req.user.sub, existante[0].classe_id, existante[0].matiere_id))) {
    return res.status(403).json({ error: "Tu n'es pas rattaché à cette classe pour cette matière." });
  }
  if (!(await saisieAutoriseePourRole(req.user.role, existante[0].periode_id))) {
    return res.status(403).json({ error: "La saisie des notes est actuellement fermée pour cette période — contacte la Direction pour qu'elle l'ouvre." });
  }
  if (Number(valeur) < 0 || Number(valeur) > Number(existante[0].note_sur)) {
    return res.status(400).json({ error: `La note doit être comprise entre 0 et ${existante[0].note_sur}.` });
  }
  const { rows } = await pool.query("UPDATE notes SET valeur = $1 WHERE id = $2 RETURNING *", [valeur, req.params.id]);
  res.json(rows[0]);
});

// DELETE /api/notes/:id
router.delete("/:id", async (req, res) => {
  const { rows: existante } = await pool.query("SELECT * FROM notes WHERE id = $1", [req.params.id]);
  if (!existante[0]) return res.status(404).json({ error: "Note introuvable." });
  if (req.user.role === "enseignant" && !(await enseignantAutorise(req.user.sub, existante[0].classe_id, existante[0].matiere_id))) {
    return res.status(403).json({ error: "Tu n'es pas rattaché à cette classe pour cette matière." });
  }
  if (!(await saisieAutoriseePourRole(req.user.role, existante[0].periode_id))) {
    return res.status(403).json({ error: "La saisie des notes est actuellement fermée pour cette période — contacte la Direction pour qu'elle l'ouvre." });
  }
  await pool.query("DELETE FROM notes WHERE id = $1", [req.params.id]);
  res.status(204).send();
});

module.exports = router;
