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

// POST /api/matieres  { nom, cycle? }  — cycle : "1er_cycle", "2nd_cycle", ou absent (commune aux deux)
router.post("/", requireRole("direction", "super_admin"), async (req, res) => {
  const { nom, cycle } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: "Le nom de la matière est requis." });
  if (cycle && !["1er_cycle", "2nd_cycle"].includes(cycle)) {
    return res.status(400).json({ error: "Cycle invalide (1er_cycle ou 2nd_cycle)." });
  }
  const ecoleId = ecoleEffective(req);
  if (!ecoleId) return res.status(400).json({ error: "Choisis d'abord une école." });

  try {
    const { rows } = await pool.query(
      "INSERT INTO matieres (nom, ecole_id, cycle) VALUES ($1, $2, $3) RETURNING *",
      [nom.trim(), ecoleId, cycle || null]
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

// DELETE /api/matieres/:id
router.delete("/:id", requireRole("direction", "super_admin"), async (req, res) => {
  await pool.query("DELETE FROM matieres WHERE id = $1", [req.params.id]);
  res.status(204).send();
});

module.exports = router;
