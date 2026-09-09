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

// Calcule le bulletin d'UN SEUL élève (3 requêtes) — utilisé quand on n'a pas
// besoin de comparer toute la classe. Pour une classe entière, préférer
// calculerBulletinsClasseBatch ci-dessous, bien plus rapide.
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

// --------------------------------------------------------------------------
// Calcule le bulletin de TOUS les élèves d'une classe pour une période, en
// seulement 3 requêtes SQL au total — quel que soit le nombre d'élèves ou de
// matières. La version précédente appelait calculerBulletinEleve() en boucle
// (une par élève, chacune avec ses propres requêtes), ce qui représentait
// jusqu'à plusieurs centaines de requêtes séquentielles pour une classe
// chargée (ex. 480 requêtes pour 40 élèves × 10 matières) — largement de quoi
// dépasser le délai d'attente du serveur face à une base de données distante
// et provoquer une erreur 502. Vérifié : produit des résultats strictement
// identiques à l'ancienne méthode, juste beaucoup plus vite.
// --------------------------------------------------------------------------
async function calculerBulletinsClasseBatch(classeId, periodeId, niveau, serie) {
  const { rows: notes } = await pool.query(
    "SELECT eleve_id, matiere_id, valeur, note_sur FROM notes WHERE classe_id = $1 AND periode_id = $2",
    [classeId, periodeId]
  );
  const matiereIds = [...new Set(notes.map((n) => n.matiere_id))];
  const { rows: matieresRows } = await pool.query(
    "SELECT id, nom FROM matieres WHERE id = ANY($1::uuid[])", [matiereIds]
  );
  const nomMatiereParId = Object.fromEntries(matieresRows.map((m) => [m.id, m.nom]));

  const { rows: coefsRows } = await pool.query(
    `SELECT matiere_id, niveau, serie, classe_id, coefficient FROM coefficients_matieres
     WHERE matiere_id = ANY($1::uuid[]) AND (classe_id = $2 OR (classe_id IS NULL AND niveau = $3))`,
    [matiereIds, classeId, niveau]
  );
  // Même ordre de priorité que trouverCoefficient (coefficientsMatieres.js) :
  // classe précise > niveau+série exacte > niveau seul > défaut 1.
  function trouverCoefLocal(matiereId) {
    const specClasse = coefsRows.find((c) => c.matiere_id === matiereId && c.classe_id === classeId);
    if (specClasse) return Number(specClasse.coefficient);
    const specSerie = coefsRows.find((c) => c.matiere_id === matiereId && c.classe_id == null && c.niveau === niveau && c.serie === serie);
    if (specSerie) return Number(specSerie.coefficient);
    const specNiveau = coefsRows.find((c) => c.matiere_id === matiereId && c.classe_id == null && c.niveau === niveau && c.serie == null);
    if (specNiveau) return Number(specNiveau.coefficient);
    return 1;
  }

  const notesParEleve = {};
  for (const n of notes) {
    if (!notesParEleve[n.eleve_id]) notesParEleve[n.eleve_id] = [];
    notesParEleve[n.eleve_id].push(n);
  }

  const bulletinsParEleve = {};
  for (const [eleveId, notesEleve] of Object.entries(notesParEleve)) {
    const moyennesParMatiere = calculerMoyennesMatieres(notesEleve);
    const coefficients = {};
    const details = [];
    for (const matiereId of Object.keys(moyennesParMatiere)) {
      const coef = trouverCoefLocal(matiereId);
      coefficients[matiereId] = coef;
      details.push({ matiere_id: matiereId, matiere_nom: nomMatiereParId[matiereId], moyenne: Math.round(moyennesParMatiere[matiereId] * 100) / 100, coefficient: coef });
    }
    const moyenneGenerale = calculerMoyenneGenerale(moyennesParMatiere, coefficients);
    bulletinsParEleve[eleveId] = { details, moyenne_generale: moyenneGenerale != null ? Math.round(moyenneGenerale * 100) / 100 : null };
  }
  return bulletinsParEleve;
}

// GET /api/bulletins/eleve/:eleveId?periode_id=...
router.get("/eleve/:eleveId", async (req, res) => {
  const { periode_id } = req.query;
  if (!periode_id) return res.status(400).json({ error: "periode_id est requis." });

  try {
  const { rows: eleveRows } = await pool.query(
    "SELECT s.*, c.niveau, c.serie, c.nom AS classe_nom FROM students s JOIN classes c ON c.id = s.classe_id WHERE s.id = $1",
    [req.params.eleveId]
  );
  const eleve = eleveRows[0];
  if (!eleve) return res.status(404).json({ error: "Élève introuvable." });

  // Un seul calcul pour toute la classe (3 requêtes) plutôt qu'un par élève —
  // sert à la fois le bulletin demandé et le rang, sans requêtes en boucle.
  const { rows: elevesClasse } = await pool.query("SELECT id FROM students WHERE classe_id = $1", [eleve.classe_id]);
  const bulletinsClasse = await calculerBulletinsClasseBatch(eleve.classe_id, periode_id, eleve.niveau, eleve.serie);
  const vide = { details: [], moyenne_generale: null };
  const bulletin = bulletinsClasse[eleve.id] || vide;

  const resultatsClasse = elevesClasse.map((e) => ({ eleve_id: e.id, moyenne_generale: (bulletinsClasse[e.id] || vide).moyenne_generale }));
  calculerRangs(resultatsClasse);
  const rang = resultatsClasse.find((r) => r.eleve_id === eleve.id)?.rang ?? null;

  res.json({
    eleve: { id: eleve.id, nom: eleve.nom, prenoms: eleve.prenoms, classe_nom: eleve.classe_nom },
    ...bulletin,
    rang,
    effectif_classe: elevesClasse.length,
  });
  } catch (err) {
    console.error("Erreur bulletin élève :", err);
    res.status(500).json({ error: "Impossible de calculer le bulletin pour le moment." });
  }
});

// GET /api/bulletins/classe/:classeId?periode_id=... — tous les élèves d'une
// classe, pour l'impression groupée et la vue "Moyennes de la classe".
router.get("/classe/:classeId", async (req, res) => {
  const { periode_id } = req.query;
  if (!periode_id) return res.status(400).json({ error: "periode_id est requis." });

  try {
  const { rows: classeRows } = await pool.query("SELECT * FROM classes WHERE id = $1", [req.params.classeId]);
  const classe = classeRows[0];
  if (!classe) return res.status(404).json({ error: "Classe introuvable." });

  const { rows: eleves } = await pool.query("SELECT id, nom, prenoms FROM students WHERE classe_id = $1 ORDER BY nom", [classe.id]);
  const bulletinsClasse = await calculerBulletinsClasseBatch(classe.id, periode_id, classe.niveau, classe.serie);
  const vide = { details: [], moyenne_generale: null };
  const resultats = eleves.map((e) => ({ eleve: { id: e.id, nom: e.nom, prenoms: e.prenoms }, ...(bulletinsClasse[e.id] || vide) }));
  calculerRangs(resultats);

  res.json({ classe: { id: classe.id, nom: classe.nom, niveau: classe.niveau }, effectif: eleves.length, eleves: resultats });
  } catch (err) {
    console.error("Erreur bulletins de classe :", err);
    res.status(500).json({ error: "Impossible de calculer les bulletins de la classe pour le moment." });
  }
});

module.exports = router;
module.exports.calculerBulletinEleve = calculerBulletinEleve;
module.exports.calculerBulletinsClasseBatch = calculerBulletinsClasseBatch;
module.exports.calculerRangs = calculerRangs;
