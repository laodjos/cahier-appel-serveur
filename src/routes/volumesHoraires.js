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

// POST /api/volumes-horaires  { matiere_id, classe_id?, niveau?, cycle?, heures_semaine }
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
