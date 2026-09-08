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

// Retrouve le coefficient applicable à une matière pour un élève donné :
// classe précise > (niveau + série, pour le 2nd cycle) > niveau seul > valeur
// par défaut 1. Utilisé aussi par le calcul de bulletin.
async function trouverCoefficient(matiereId, niveau, classeId, serie) {
  const { rows } = await pool.query(
    `SELECT coefficient FROM coefficients_matieres
     WHERE matiere_id = $1 AND (
       classe_id = $2
       OR (classe_id IS NULL AND niveau = $3 AND serie IS NOT DISTINCT FROM $4)
       OR (classe_id IS NULL AND niveau = $3 AND serie IS NULL)
     )
     ORDER BY classe_id NULLS LAST, serie NULLS LAST LIMIT 1`,
    [matiereId, classeId, niveau, serie || null]
  );
  return rows[0]?.coefficient != null ? Number(rows[0].coefficient) : 1;
}

// GET /api/coefficients-matieres
router.get("/", async (req, res) => {
  const params = [];
  let filtre = "TRUE";
  const ecoleId = ecoleEffective(req);
  if (ecoleId) { params.push(ecoleId); filtre += ` AND cm.ecole_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT cm.*, m.nom AS matiere_nom, cl.nom AS classe_nom FROM coefficients_matieres cm
     JOIN matieres m ON m.id = cm.matiere_id
     LEFT JOIN classes cl ON cl.id = cm.classe_id
     WHERE ${filtre} ORDER BY m.nom`,
    params
  );
  res.json(rows);
});

// POST /api/coefficients-matieres  { matiere_id, niveau?, serie?, classe_id?, coefficient }
router.post("/", requireRole("direction", "super_admin"), async (req, res) => {
  const { matiere_id, niveau, serie, classe_id, coefficient } = req.body;
  if (!matiere_id || coefficient == null) return res.status(400).json({ error: "matiere_id et coefficient sont requis." });
  if (!niveau && !classe_id) return res.status(400).json({ error: "Précise un niveau ou une classe pour ce coefficient." });
  const ecoleId = ecoleEffective(req);
  const { rows } = await pool.query(
    `INSERT INTO coefficients_matieres (ecole_id, matiere_id, niveau, serie, classe_id, coefficient)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [ecoleId, matiere_id, classe_id ? null : (niveau || null), classe_id ? null : (serie || null), classe_id || null, coefficient]
  );
  res.status(201).json(rows[0]);
});

// --------------------------------------------------------------------------
// Table de référence des coefficients — Maths/Physique-Chimie/SVT/Philosophie
// sont confirmés par plusieurs sources recoupées (DECO, guides de préparation
// au BAC 2026) ; les matières secondaires sont des estimations raisonnables.
// ⚠ Les coefficients officiels peuvent évoluer d'une année à l'autre — à
// vérifier auprès de la DECO/du lycée avant tout usage officiel (bulletins
// transmis aux familles, dossiers d'orientation).
// --------------------------------------------------------------------------
const COEFFICIENTS_1ER_CYCLE = {
  "composition francaise": 2, "orthographe-grammaire": 2, "expression orale": 1,
  "mathematiques": 3, "anglais": 2, "histoire-geographie": 2,
  "svt": 2, "physique-chimie": 2, "edhc": 1, "emc": 1, "arts plastiques": 1,
  "eps": 1, "education musicale": 1,
};
// Au 2nd cycle (lycée), le Français reste une seule matière globale — la
// décomposition en trois épreuves (Composition/Orthographe/Expression orale)
// ne s'applique qu'au 1er cycle (voir COEFFICIENTS_1ER_CYCLE ci-dessus).
const COEFFICIENTS_2ND_CYCLE = {
  "a1": { "philosophie": 5, "francais": 4, "anglais": 4, "histoire-geographie": 3, "mathematiques": 2, "eps": 1 },
  "a2": { "philosophie": 4, "francais": 4, "anglais": 3, "histoire-geographie": 3, "mathematiques": 2, "eps": 1 },
  "c": { "mathematiques": 5, "physique-chimie": 5, "svt": 2, "philosophie": 2, "francais": 2, "histoire-geographie": 1, "anglais": 1, "eps": 1 },
  "d": { "mathematiques": 4, "physique-chimie": 4, "svt": 4, "philosophie": 2, "francais": 2, "histoire-geographie": 1, "anglais": 1, "eps": 1 },
};

function normaliser(texte) {
  return texte.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

// Correspondance par "mot entier" plutôt que sous-chaîne brute — une simple
// sous-chaîne aurait fait matcher à tort "Composition Française" avec la clé
// "francais" (puisque "française" commence par "francais"). La clé doit être
// entourée de limites non-alphabétiques (début/fin, espace, tiret, parenthèse).
function contientMotEntier(texte, mot) {
  const echappe = mot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z])${echappe}([^a-z]|$)`).test(texte);
}

function trouverDansTable(table, nomNorm) {
  if (table[nomNorm] != null) return table[nomNorm];
  const cle = Object.keys(table).find((k) => contientMotEntier(nomNorm, k) || contientMotEntier(k, nomNorm));
  return cle ? table[cle] : null;
}

// Le cycle se détermine par le NIVEAU, pas par la présence d'une série — le
// 2nd cycle commence dès la 2nde. Important : en 2nde, seules les séries A et
// C existent (pas encore de D, qui n'apparaît qu'à partir de la 1ère/Terminale,
// souvent par scission de la filière C). Le Français y reste un bloc unique
// (le découpage en trois épreuves ne concerne que le 1er cycle).
const NIVEAUX_2ND_CYCLE = ["2nde", "1ere", "terminale"];

function trouverCoefficientReference(nomMatiere, niveau, serie) {
  const nomNorm = normaliser(nomMatiere);
  const niveauNorm = normaliser(niveau || "");
  const estSecondCycle = NIVEAUX_2ND_CYCLE.includes(niveauNorm);
  if (!estSecondCycle) return trouverDansTable(COEFFICIENTS_1ER_CYCLE, nomNorm);
  // La table de référence ci-dessus (A1/A2/C/D) documente des coefficients de
  // BAC (1ère/Terminale) — on ne sait pas s'ils s'appliquent tels quels à la
  // 2nde, dont les séries A/C sont moins différenciées. Par prudence, on ne
  // devine aucun coefficient en 2nde plutôt que de réutiliser à tort ceux de
  // Terminale — à compléter si tu obtiens les vrais barèmes de 2nde.
  if (niveauNorm === "2nde") return null;
  const table = serie ? COEFFICIENTS_2ND_CYCLE[normaliser(serie)] : null;
  return table ? trouverDansTable(table, nomNorm) : null;
}

// POST /api/coefficients-matieres/generer-automatiquement
// Remplit automatiquement les coefficients manquants, pour les niveaux/séries
// réellement utilisés par les classes de l'établissement, à partir de la table
// de référence ci-dessus. Ne touche jamais un coefficient déjà défini.
router.post("/generer-automatiquement", requireRole("direction", "super_admin"), async (req, res) => {
  const ecoleId = ecoleEffective(req);
  if (!ecoleId) return res.status(400).json({ error: "Choisis d'abord une école." });

  const { rows: matieres } = await pool.query("SELECT id, nom FROM matieres WHERE ecole_id = $1", [ecoleId]);
  const { rows: combosNiveauSerie } = await pool.query(
    "SELECT DISTINCT niveau, serie FROM classes WHERE ecole_id = $1 AND niveau IS NOT NULL", [ecoleId]
  );
  const { rows: dejaExistants } = await pool.query(
    "SELECT matiere_id, niveau, serie FROM coefficients_matieres WHERE ecole_id = $1 AND classe_id IS NULL", [ecoleId]
  );
  const dejaExistantsSet = new Set(dejaExistants.map((c) => `${c.matiere_id}|${c.niveau}|${c.serie || ""}`));

  let creees = 0;
  for (const combo of combosNiveauSerie) {
    for (const m of matieres) {
      const cle = `${m.id}|${combo.niveau}|${combo.serie || ""}`;
      if (dejaExistantsSet.has(cle)) continue; // ne jamais écraser un coefficient déjà défini
      const coef = trouverCoefficientReference(m.nom, combo.niveau, combo.serie);
      if (coef == null) continue; // matière non couverte par la table de référence -> on laisse à 1 par défaut, sans créer de ligne inutile
      await pool.query(
        "INSERT INTO coefficients_matieres (ecole_id, matiere_id, niveau, serie, coefficient) VALUES ($1, $2, $3, $4, $5)",
        [ecoleId, m.id, combo.niveau, combo.serie || null, coef]
      );
      dejaExistantsSet.add(cle);
      creees++;
    }
  }
  res.status(201).json({ creees });
});

// DELETE /api/coefficients-matieres/:id
router.delete("/:id", requireRole("direction", "super_admin"), async (req, res) => {
  await pool.query("DELETE FROM coefficients_matieres WHERE id = $1", [req.params.id]);
  res.status(204).send();
});

module.exports = router;
module.exports.trouverCoefficient = trouverCoefficient;
