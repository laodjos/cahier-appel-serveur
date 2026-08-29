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

// POST /api/matieres  { nom, cycle?, categorie?, duree_double? }
// cycle : "1er_cycle", "2nd_cycle", ou absent (commune aux deux)
// categorie : "scientifique", "litteraire", ou absente (aucune contrainte d'enchaînement)
// duree_double : true si cette matière doit toujours être programmée sur 2h d'affilée (ex. EPS)
router.post("/", requireRole("direction", "super_admin"), async (req, res) => {
  const { nom, cycle, categorie, duree_double } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: "Le nom de la matière est requis." });
  if (cycle && !["1er_cycle", "2nd_cycle"].includes(cycle)) {
    return res.status(400).json({ error: "Cycle invalide (1er_cycle ou 2nd_cycle)." });
  }
  if (categorie && !["scientifique", "litteraire"].includes(categorie)) {
    return res.status(400).json({ error: "Catégorie invalide (scientifique ou litteraire)." });
  }
  const ecoleId = ecoleEffective(req);
  if (!ecoleId) return res.status(400).json({ error: "Choisis d'abord une école." });

  try {
    const { rows } = await pool.query(
      "INSERT INTO matieres (nom, ecole_id, cycle, categorie, duree_double) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [nom.trim(), ecoleId, cycle || null, categorie || null, !!duree_double]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Cette matière existe déjà." });
    throw err;
  }
});

// POST /api/matieres/generer-defaut — pré-remplit une liste de base, répartie par cycle.
// C'est un point de départ courant (programme ivoirien) — à ajuster/compléter ensuite,
// notamment pour les matières de spécialité qui varient selon la série au lycée.
router.post("/generer-defaut", requireRole("direction", "super_admin"), async (req, res) => {
  const ecoleId = ecoleEffective(req);
  if (!ecoleId) return res.status(400).json({ error: "Choisis d'abord une école." });

  const MATIERES_PAR_DEFAUT = [
    // Communes aux deux cycles
    { nom: "Mathématiques", cycle: null },
    { nom: "Français", cycle: null },
    { nom: "Anglais", cycle: null },
    { nom: "Histoire-Géographie", cycle: null },
    { nom: "Éducation Physique et Sportive (EPS)", cycle: null },
    { nom: "Physique-Chimie", cycle: null },
    { nom: "Sciences de la Vie et de la Terre (SVT)", cycle: null },
    { nom: "Espagnol (LV2)", cycle: null },
    { nom: "Allemand (LV2)", cycle: null },
    // 1er cycle uniquement (Collège : 6ème à 3ème)
    { nom: "Éducation Morale et Civique (EMC)", cycle: "1er_cycle" },
    { nom: "Arts Plastiques", cycle: "1er_cycle" },
    { nom: "Éducation Musicale", cycle: "1er_cycle" },
    // 2nd cycle uniquement (Lycée : 2nde à Terminale)
    { nom: "Philosophie", cycle: "2nd_cycle" },
    { nom: "Économie", cycle: "2nd_cycle" },
    { nom: "Comptabilité", cycle: "2nd_cycle" },
  ];

  const creees = [];
  for (const m of MATIERES_PAR_DEFAUT) {
    const { rows } = await pool.query(
      `INSERT INTO matieres (nom, ecole_id, cycle) VALUES ($1, $2, $3)
       ON CONFLICT (nom, ecole_id) DO NOTHING RETURNING *`,
      [m.nom, ecoleId, m.cycle]
    );
    if (rows[0]) creees.push(rows[0]);
  }
  res.status(201).json({ creees, total_demandees: MATIERES_PAR_DEFAUT.length });
});

// PATCH /api/matieres/:id  { categorie?, duree_double? }
router.patch("/:id", requireRole("direction", "super_admin"), async (req, res) => {
  const { categorie, duree_double } = req.body;
  if (categorie !== undefined && categorie && !["scientifique", "litteraire"].includes(categorie)) {
    return res.status(400).json({ error: "Catégorie invalide (scientifique ou litteraire)." });
  }
  const { rows } = await pool.query(
    `UPDATE matieres SET
       categorie = CASE WHEN $1::text IS NOT NULL THEN NULLIF($1, '') ELSE categorie END,
       duree_double = COALESCE($2, duree_double)
     WHERE id = $3 RETURNING *`,
    [categorie !== undefined ? (categorie || "") : null, duree_double !== undefined ? duree_double : null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Matière introuvable." });
  res.json(rows[0]);
});

// DELETE /api/matieres/:id
router.delete("/:id", requireRole("direction", "super_admin"), async (req, res) => {
  await pool.query("DELETE FROM matieres WHERE id = $1", [req.params.id]);
  res.status(204).send();
});

// GET /api/matieres/:id/volumes — volume horaire hebdomadaire configuré pour cette matière
router.get("/:id/volumes", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM matieres_volumes WHERE matiere_id = $1 ORDER BY niveau NULLS LAST, cycle NULLS LAST", [req.params.id]);
  res.json(rows);
});

// POST /api/matieres/:id/volumes  { niveau?, cycle?, heures_semaine }
// Précise soit un niveau exact (ex. "6ème"), soit tout un cycle (si niveau vide) — pas les deux à la fois.
router.post("/:id/volumes", requireRole("direction", "super_admin"), async (req, res) => {
  const { niveau, cycle, heures_semaine } = req.body;
  if (!heures_semaine || Number(heures_semaine) <= 0) {
    return res.status(400).json({ error: "Le nombre d'heures par semaine doit être supérieur à 0." });
  }
  if (!niveau && !cycle) {
    return res.status(400).json({ error: "Précise un niveau ou un cycle." });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO matieres_volumes (matiere_id, niveau, cycle, heures_semaine) VALUES ($1, $2, $3, $4)
       ON CONFLICT (matiere_id, niveau, cycle) DO UPDATE SET heures_semaine = EXCLUDED.heures_semaine
       RETURNING *`,
      [req.params.id, niveau || null, niveau ? null : (cycle || null), heures_semaine]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    throw err;
  }
});

// DELETE /api/matieres/volumes/:volumeId
router.delete("/volumes/:volumeId", requireRole("direction", "super_admin"), async (req, res) => {
  await pool.query("DELETE FROM matieres_volumes WHERE id = $1", [req.params.volumeId]);
  res.status(204).send();
});

module.exports = router;
