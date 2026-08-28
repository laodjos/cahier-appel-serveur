const express = require("express");
const { pool } = require("../config/db");
const { authRequired, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);

const NIVEAUX_PAR_DEFAUT = ["6ème", "5ème", "4ème", "3ème", "2nde", "1ère", "Terminale"];

// ecole_id NULL sur le compte = direction générale (voit et gère toutes les écoles).
// ecole_id renseigné = ne voit et ne peut créer que dans sa propre école.
// Renvoie l'école sur laquelle filtrer :
// - un compte rattaché à une école (direction, enseignant, surveillant) est TOUJOURS
//   restreint à SA propre école, quoi qu'il envoie dans la requête ;
// - un Super-administrateur (ecole_id NULL) peut choisir une école à consulter en
//   l'envoyant en paramètre (?ecole_id=... ou body.ecole_id) — sinon il voit tout.
function ecoleEffective(req) {
  if (req.user.ecole_id) return req.user.ecole_id;
  return req.query?.ecole_id || req.body?.ecole_id || null;
}

function clauseEcole(req, params, colonne = "ecole_id") {
  const ecoleId = ecoleEffective(req);
  if (ecoleId) {
    params.push(ecoleId);
    return `${colonne} = $${params.length}`;
  }
  return "TRUE"; // Super-administrateur en vue globale : pas de restriction
}

// GET /api/classes
router.get("/", async (req, res) => {
  const params = [];
  const filtreEcole = clauseEcole(req, params, "c.ecole_id");

  if (req.user.role === "enseignant") {
    params.push(req.user.sub);
    const { rows } = await pool.query(
      `SELECT c.*, e.nom AS ecole_nom FROM classes c
       JOIN enseignant_classes ec ON ec.classe_id = c.id
       LEFT JOIN ecoles e ON e.id = c.ecole_id
       WHERE ec.user_id = $${params.length} AND ${filtreEcole}
       ORDER BY c.niveau NULLS LAST, c.nom`,
      params
    );
    return res.json(rows);
  }

  const { rows } = await pool.query(
    `SELECT c.*, e.nom AS ecole_nom FROM classes c
     LEFT JOIN ecoles e ON e.id = c.ecole_id
     WHERE ${filtreEcole}
     ORDER BY e.nom NULLS FIRST, c.niveau NULLS LAST, c.nom`,
    params
  );
  res.json(rows);
});

// POST /api/classes/generer-defaut
router.post("/generer-defaut", requireRole("direction", "super_admin"), async (req, res) => {
  const ecoleId = ecoleEffective(req);
  if (!ecoleId) {
    return res.status(400).json({ error: "Choisis d'abord l'école pour laquelle générer les classes." });
  }
  const creees = [];
  for (const niveau of NIVEAUX_PAR_DEFAUT) {
    const nom = `${niveau} A`;
    const { rows } = await pool.query(
      `INSERT INTO classes (nom, niveau, ecole_id) VALUES ($1, $2, $3)
       ON CONFLICT (nom) DO NOTHING RETURNING *`,
      [nom, niveau, ecoleId]
    );
    if (rows[0]) creees.push(rows[0]);
  }
  res.status(201).json({ creees, total_demandees: NIVEAUX_PAR_DEFAUT.length });
});

// POST /api/classes  { nom, niveau, ecole_id? }
router.post("/", requireRole("direction", "super_admin"), async (req, res) => {
  const { nom, niveau, vacation } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: "Le nom de la classe est requis." });

  const ecoleCible = ecoleEffective(req);

  try {
    const { rows } = await pool.query(
      "INSERT INTO classes (nom, niveau, ecole_id, vacation) VALUES ($1, $2, $3, $4) RETURNING *",
      [nom.trim(), niveau?.trim() || null, ecoleCible, vacation || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Cette classe existe déjà." });
    throw err;
  }
});

// PATCH /api/classes/:id/vacation  { vacation } — définit la vacation (matin/après-midi) d'une classe
// PATCH /api/classes/:id  { nom?, niveau? } — correction du nom et/ou du niveau d'une classe
router.patch("/:id", requireRole("direction", "super_admin"), async (req, res) => {
  const { nom, niveau } = req.body;
  if (nom === undefined && niveau === undefined) {
    return res.status(400).json({ error: "Indique au moins un nom ou un niveau à corriger." });
  }

  const champs = [];
  const params = [];
  if (nom !== undefined && nom.trim()) { params.push(nom.trim()); champs.push(`nom = $${params.length}`); }
  if (niveau !== undefined) { params.push(niveau?.trim() || null); champs.push(`niveau = $${params.length}`); }

  params.push(req.params.id);
  const indexId = params.length; // capturé AVANT clauseEcole, qui peut ajouter un paramètre après
  const filtreEcole = clauseEcole(req, params);

  try {
    const { rows } = await pool.query(
      `UPDATE classes SET ${champs.join(", ")} WHERE id = $${indexId} AND ${filtreEcole} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: "Classe introuvable (ou hors de ton école)." });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Une classe porte déjà ce nom." });
    throw err;
  }
});

router.patch("/:id/vacation", requireRole("direction", "super_admin"), async (req, res) => {
  const { vacation } = req.body;
  if (vacation && !["matin", "apres_midi"].includes(vacation)) {
    return res.status(400).json({ error: "Vacation invalide (matin ou apres_midi)." });
  }
  const params = [vacation || null, req.params.id];
  const filtreEcole = clauseEcole(req, params);
  const { rows } = await pool.query(`UPDATE classes SET vacation = $1 WHERE id = $2 AND ${filtreEcole} RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: "Classe introuvable (ou hors de ton école)." });
  res.json(rows[0]);
});

// DELETE /api/classes/:id
router.delete("/:id", requireRole("direction", "super_admin"), async (req, res) => {
  const params = [req.params.id];
  const filtreEcole = clauseEcole(req, params);
  const { rowCount } = await pool.query(`DELETE FROM classes WHERE id = $1 AND ${filtreEcole}`, params);
  if (rowCount === 0) return res.status(404).json({ error: "Classe introuvable (ou hors de ton école)." });
  res.status(204).send();
});

// DELETE /api/classes/niveau/:niveau
router.delete("/niveau/:niveau", requireRole("direction", "super_admin"), async (req, res) => {
  const params = [req.params.niveau];
  const filtreEcole = clauseEcole(req, params);
  const { rowCount } = await pool.query(`DELETE FROM classes WHERE niveau = $1 AND ${filtreEcole}`, params);
  res.json({ supprimees: rowCount });
});

module.exports = router;
