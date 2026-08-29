const express = require("express");
const { pool } = require("../config/db");
const { authRequired, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);

function ecoleEffective(req) {
  if (req.user.ecole_id) return req.user.ecole_id;
  return req.query?.ecole_id || req.body?.ecole_id || null;
}

// GET /api/volumes-horaires
router.get("/", async (req, res) => {
  const params = [];
  let filtre = "TRUE";
  const ecoleId = ecoleEffective(req);
  if (ecoleId) { params.push(ecoleId); filtre = `vh.ecole_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT vh.*, m.nom AS matiere_nom, c.nom AS classe_nom FROM volumes_horaires vh
     JOIN matieres m ON m.id = vh.matiere_id
     LEFT JOIN classes c ON c.id = vh.classe_id
     WHERE ${filtre}
     ORDER BY m.nom, c.nom NULLS LAST, vh.niveau NULLS LAST`,
    params
  );
  res.json(rows);
});

// POST /api/volumes-horaires/generer-officiel-1er-cycle
// Pré-remplit UNIQUEMENT les matières dont le volume horaire est identique sur
// tout le 1er cycle (6ème à 3ème), d'après la circulaire n°0311/MENA/CAB/DPFC
// du 01/09/2025 (Côte d'Ivoire). Les matières dont le volume change selon le
// niveau ou la série (Français, Mathématiques, L.V.2, Histoire-Géo, matières de
// lycée...) ne sont PAS pré-remplies ici — à saisir toi-même en te basant sur
// le tableau officiel, pour éviter tout risque d'erreur de lecture de ma part
// sur un document dont certaines cases sont fusionnées ou en diagonale.
router.post("/generer-officiel-1er-cycle", requireRole("direction", "super_admin"), async (req, res) => {
  const ecoleId = ecoleEffective(req);
  if (!ecoleId) return res.status(400).json({ error: "Choisis d'abord une école." });

  const VALEURS = [
    { matiere: "Anglais", heures: 2 },
    { matiere: "Arts Plastiques/Ed.Musicale", heures: 1 },
    { matiere: "Éducation aux Droits de l'Homme et à la Citoyenneté (EDHC)", heures: 1 },
    { matiere: "Éducation Physique et Sportive (EPS)", heures: 1 },
  ];

  const creees = [];
  for (const v of VALEURS) {
    // Cherche une matière déjà existante avec un nom proche (insensible à la casse/accents) ;
    // sinon la crée avec le nom officiel.
    const { rows: existantes } = await pool.query(
      "SELECT id, nom FROM matieres WHERE ecole_id = $1 AND nom ILIKE $2",
      [ecoleId, `%${v.matiere.split("(")[0].split("/")[0].trim().split(" ")[0]}%`]
    );
    let matiereId;
    if (existantes[0]) {
      matiereId = existantes[0].id;
    } else {
      const { rows } = await pool.query(
        "INSERT INTO matieres (nom, ecole_id, cycle) VALUES ($1, $2, '1er_cycle') RETURNING id",
        [v.matiere, ecoleId]
      );
      matiereId = rows[0].id;
    }

    const { rows: inseree } = await pool.query(
      `INSERT INTO volumes_horaires (ecole_id, matiere_id, cycle, heures_semaine)
       SELECT $1, $2, '1er_cycle', $3
       WHERE NOT EXISTS (
         SELECT 1 FROM volumes_horaires WHERE ecole_id = $1 AND matiere_id = $2 AND cycle = '1er_cycle' AND classe_id IS NULL AND niveau IS NULL
       )
       RETURNING *`,
      [ecoleId, matiereId, v.heures]
    );
    if (inseree[0]) creees.push({ ...inseree[0], matiere_nom: v.matiere });
  }

  res.status(201).json({ creees, total_demandees: VALEURS.length });
});


// Priorité du plus précis au plus général : classe_id > niveau > cycle.
router.post("/", requireRole("direction", "super_admin"), async (req, res) => {
  const { matiere_id, classe_id, niveau, cycle, heures_semaine } = req.body;
  if (!matiere_id || !heures_semaine) return res.status(400).json({ error: "matiere_id et heures_semaine sont requis." });
  if (!classe_id && !niveau && !cycle) return res.status(400).json({ error: "Précise une classe, un niveau, ou au moins un cycle." });
  const ecoleId = ecoleEffective(req);
  if (!ecoleId) return res.status(400).json({ error: "Choisis d'abord une école." });

  const classeCible = classe_id || null;
  const niveauCible = classeCible ? null : (niveau || null);
  const cycleCible = (classeCible || niveauCible) ? null : (cycle || null);

  const { rows } = await pool.query(
    `INSERT INTO volumes_horaires (ecole_id, matiere_id, classe_id, niveau, cycle, heures_semaine)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [ecoleId, matiere_id, classeCible, niveauCible, cycleCible, heures_semaine]
  );
  res.status(201).json(rows[0]);
});

// DELETE /api/volumes-horaires/:id
router.delete("/:id", requireRole("direction", "super_admin"), async (req, res) => {
  await pool.query("DELETE FROM volumes_horaires WHERE id = $1", [req.params.id]);
  res.status(204).send();
});

module.exports = router;
