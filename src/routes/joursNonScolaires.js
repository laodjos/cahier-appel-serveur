const express = require("express");
const { pool } = require("../config/db");
const { authRequired, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);

// Jours fériés officiels Côte d'Ivoire 2026 (sources : Code du travail, décret n°96-205
// modifié par le décret n°2011-371, calendrier ASACI 2026, communiqués officiels).
// ⚠ Les dates liées au calendrier lunaire musulman (Aïd el-Fitr, Tabaski) sont
// susceptibles de glisser d'un jour selon l'observation officielle du croissant —
// vérifie et corrige si besoin une fois la date confirmée par le gouvernement.
const FERIES_CI_2026 = [
  { date: "2026-01-01", libelle: "Jour de l'an" },
  { date: "2026-03-16", libelle: "Lendemain de la Nuit du Destin (Laylatoul-Kadr)" },
  { date: "2026-03-19", libelle: "Aïd el-Fitr (fin du Ramadan)" },
  { date: "2026-04-06", libelle: "Lundi de Pâques" },
  { date: "2026-05-01", libelle: "Fête du Travail" },
  { date: "2026-05-14", libelle: "Ascension" },
  { date: "2026-05-25", libelle: "Lundi de Pentecôte" },
  { date: "2026-05-26", libelle: "Aïd El Kebir (Tabaski)" },
  { date: "2026-08-07", libelle: "Fête Nationale" },
  { date: "2026-11-01", libelle: "La Toussaint" },
  { date: "2026-11-15", libelle: "Journée Nationale de la Paix" },
  { date: "2026-12-25", libelle: "Noël" },
];

// GET /api/jours-non-scolaires?annee=2026
router.get("/", async (req, res) => {
  const params = [];
  let where = "";
  if (req.query.annee) {
    params.push(`${req.query.annee}-01-01`, `${req.query.annee}-12-31`);
    where = "WHERE date BETWEEN $1 AND $2";
  }
  const { rows } = await pool.query(`SELECT * FROM jours_non_scolaires ${where} ORDER BY date`, params);
  res.json(rows);
});

// POST /api/jours-non-scolaires  { date, libelle }
router.post("/", requireRole("direction", "super_admin"), async (req, res) => {
  const { date, libelle } = req.body;
  if (!date) return res.status(400).json({ error: "La date est requise." });
  const { rows } = await pool.query(
    `INSERT INTO jours_non_scolaires (date, libelle) VALUES ($1, $2)
     ON CONFLICT (date) DO UPDATE SET libelle = EXCLUDED.libelle RETURNING *`,
    [date, libelle || null]
  );
  res.status(201).json(rows[0]);
});

// POST /api/jours-non-scolaires/preremplir-2026 — ajoute d'un coup les fériés officiels connus
router.post("/preremplir-2026", requireRole("direction", "super_admin"), async (req, res) => {
  const ajoutes = [];
  for (const f of FERIES_CI_2026) {
    const { rows } = await pool.query(
      `INSERT INTO jours_non_scolaires (date, libelle) VALUES ($1, $2)
       ON CONFLICT (date) DO NOTHING RETURNING *`,
      [f.date, f.libelle]
    );
    if (rows[0]) ajoutes.push(rows[0]);
  }
  res.status(201).json({ ajoutes: ajoutes.length, total: FERIES_CI_2026.length, details: ajoutes });
});

// DELETE /api/jours-non-scolaires/:date
router.delete("/:date", requireRole("direction", "super_admin"), async (req, res) => {
  await pool.query("DELETE FROM jours_non_scolaires WHERE date = $1", [req.params.date]);
  res.status(204).send();
});

module.exports = router;
