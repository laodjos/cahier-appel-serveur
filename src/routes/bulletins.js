const express = require("express");
const { pool } = require("../config/db");
const { authRequired, requireErpActif } = require("../middleware/auth");
const { trouverCoefficient } = require("./coefficientsMatieres");

const router = express.Router();
router.use(authRequired);
router.use(requireErpActif);

// Moyenne d'un élève par matière, sur une période — normalisée sur 20 même si
// une note a été saisie sur un barème différent (ex. devoir noté sur 10).
function calculerMoyennesMatieres(notes) {
  const parMatiere = {};
  for (const n of notes) {
    if (!parMatiere[n.matiere_id]) parMatiere[n.matiere_id] = [];
    parMatiere[n.matiere_id].push((Number(n.valeur) / Number(n.note_sur)) * 20);
  }
  const moyennes = {};
  for (const [matiereId, valeurs] of Object.entries(parMatiere)) {
    moyennes[matiereId] = valeurs.reduce((a, b) => a + b, 0) / valeurs.length;
  }
  return moyennes;
}

function calculerMoyenneGenerale(moyennesParMatiere, coefficients) {
  let sommePoints = 0, sommeCoefs = 0;
  for (const [matiereId, moyenne] of Object.entries(moyennesParMatiere)) {
    const coef = coefficients[matiereId] || 1;
    sommePoints += moyenne * coef;
    sommeCoefs += coef;
  }
  return sommeCoefs > 0 ? sommePoints / sommeCoefs : null;
}

// Classement standard "olympique" : deux moyennes identiques partagent le même
// rang, et la place suivante saute d'autant (1er, 1er ex-æquo, 3ème...).
function calculerRangs(resultats) {
  const classement = [...resultats].filter((r) => r.moyenne_generale != null).sort((a, b) => b.moyenne_generale - a.moyenne_generale);
  let rangCourant = 0, dernierePlace = 0, derniereValeur = null;
  for (const r of classement) {
    rangCourant++;
    if (r.moyenne_generale !== derniereValeur) { dernierePlace = rangCourant; derniereValeur = r.moyenne_generale; }
    r.rang = dernierePlace;
  }
  for (const r of resultats) if (r.moyenne_generale == null) r.rang = null;
  return resultats;
}

// Calcule le bulletin complet (moyennes par matière + moyenne générale) d'un
// élève pour une période — fonction interne réutilisée pour un élève seul ou
// pour toute une classe (calcul du rang).
async function calculerBulletinEleve(eleveId, periodeId, classeId, niveau, serie) {
  const { rows: notes } = await pool.query(
    "SELECT matiere_id, valeur, note_sur FROM notes WHERE eleve_id = $1 AND periode_id = $2",
    [eleveId, periodeId]
  );
  const moyennesParMatiere = calculerMoyennesMatieres(notes);
  const { rows: matieresRows } = await pool.query(
    "SELECT id, nom FROM matieres WHERE id = ANY($1::uuid[])",
    [Object.keys(moyennesParMatiere)]
  );
  const coefficients = {};
  const details = [];
  for (const m of matieresRows) {
    const coef = await trouverCoefficient(m.id, niveau, classeId, serie);
    coefficients[m.id] = coef;
    details.push({ matiere_id: m.id, matiere_nom: m.nom, moyenne: Math.round(moyennesParMatiere[m.id] * 100) / 100, coefficient: coef });
  }
  const moyenneGenerale = calculerMoyenneGenerale(moyennesParMatiere, coefficients);
  return { details, moyenne_generale: moyenneGenerale != null ? Math.round(moyenneGenerale * 100) / 100 : null };
}

// GET /api/bulletins/eleve/:eleveId?periode_id=...
router.get("/eleve/:eleveId", async (req, res) => {
  const { periode_id } = req.query;
  if (!periode_id) return res.status(400).json({ error: "periode_id est requis." });

  const { rows: eleveRows } = await pool.query(
    "SELECT s.*, c.niveau, c.serie, c.nom AS classe_nom FROM students s JOIN classes c ON c.id = s.classe_id WHERE s.id = $1",
    [req.params.eleveId]
  );
  const eleve = eleveRows[0];
  if (!eleve) return res.status(404).json({ error: "Élève introuvable." });

  const bulletin = await calculerBulletinEleve(eleve.id, periode_id, eleve.classe_id, eleve.niveau, eleve.serie);

  // Rang de l'élève dans sa classe pour cette période — recalcule la moyenne de
  // chaque camarade de classe pour comparer (peu coûteux : une classe reste petite).
  const { rows: elevesClasse } = await pool.query("SELECT id FROM students WHERE classe_id = $1", [eleve.classe_id]);
  const resultatsClasse = [];
  for (const e of elevesClasse) {
    const b = await calculerBulletinEleve(e.id, periode_id, eleve.classe_id, eleve.niveau, eleve.serie);
    resultatsClasse.push({ eleve_id: e.id, moyenne_generale: b.moyenne_generale });
  }
  calculerRangs(resultatsClasse);
  const rang = resultatsClasse.find((r) => r.eleve_id === eleve.id)?.rang ?? null;

  res.json({
    eleve: { id: eleve.id, nom: eleve.nom, classe_nom: eleve.classe_nom },
    ...bulletin,
    rang,
    effectif_classe: elevesClasse.length,
  });
});

// GET /api/bulletins/classe/:classeId?periode_id=... — tous les élèves d'une
// classe, pour l'impression groupée.
router.get("/classe/:classeId", async (req, res) => {
  const { periode_id } = req.query;
  if (!periode_id) return res.status(400).json({ error: "periode_id est requis." });

  const { rows: classeRows } = await pool.query("SELECT * FROM classes WHERE id = $1", [req.params.classeId]);
  const classe = classeRows[0];
  if (!classe) return res.status(404).json({ error: "Classe introuvable." });

  const { rows: eleves } = await pool.query("SELECT id, nom FROM students WHERE classe_id = $1 ORDER BY nom", [classe.id]);
  const resultats = [];
  for (const e of eleves) {
    const b = await calculerBulletinEleve(e.id, periode_id, classe.id, classe.niveau, classe.serie);
    resultats.push({ eleve: { id: e.id, nom: e.nom }, ...b });
  }
  calculerRangs(resultats);

  res.json({ classe: { id: classe.id, nom: classe.nom, niveau: classe.niveau }, effectif: eleves.length, eleves: resultats });
});

module.exports = router;
