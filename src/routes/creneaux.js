const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const { pool } = require("../config/db");
const { authRequired, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function ecoleEffective(req) {
  if (req.user.ecole_id) return req.user.ecole_id;
  return req.query?.ecole_id || req.body?.ecole_id || null;
}

// Logique de création partagée entre la saisie manuelle (POST /) et l'import en masse —
// vérifie les chevauchements (classe, enseignant, salle) puis insère si tout est ok.
// Renvoie { creneau } en cas de succès, ou { erreur } sinon (jamais les deux).
async function creerCreneauValide({ classe_id, jour_semaine, date_exceptionnelle, heure_debut, heure_fin, matiere, enseignant, salle_id, est_pause }) {
  if (!classe_id || (!jour_semaine && !date_exceptionnelle) || !heure_debut || !heure_fin || !matiere) {
    return { erreur: "classe_id, (jour_semaine OU date_exceptionnelle), heure_debut, heure_fin et matiere sont requis." };
  }
  if (heure_fin <= heure_debut) {
    return { erreur: "L'heure de fin doit être après l'heure de début." };
  }

  const filtreJour = date_exceptionnelle ? "date_exceptionnelle = $2" : "jour_semaine = $2";
  const valeurJour = date_exceptionnelle || jour_semaine;

  const { rows: chevaucheClasse } = await pool.query(
    `SELECT id, matiere FROM creneaux
     WHERE classe_id = $1 AND ${filtreJour}
       AND heure_debut < $4 AND heure_fin > $3`,
    [classe_id, valeurJour, heure_debut, heure_fin]
  );
  if (chevaucheClasse.length > 0) {
    return { erreur: `Cette classe a déjà "${chevaucheClasse[0].matiere}" sur ce créneau — chevauchement impossible.` };
  }

  if (enseignant && enseignant.trim()) {
    const { rows: chevaucheEnseignant } = await pool.query(
      `SELECT cr.id, cr.matiere, cl.nom AS classe_nom FROM creneaux cr
       JOIN classes cl ON cl.id = cr.classe_id
       WHERE cr.enseignant = $1 AND ${filtreJour.replace("date_exceptionnelle", "cr.date_exceptionnelle").replace("jour_semaine", "cr.jour_semaine")}
         AND cr.heure_debut < $4 AND cr.heure_fin > $3`,
      [enseignant.trim(), valeurJour, heure_debut, heure_fin]
    );
    if (chevaucheEnseignant.length > 0) {
      return { erreur: `${enseignant} donne déjà "${chevaucheEnseignant[0].matiere}" en ${chevaucheEnseignant[0].classe_nom} sur ce créneau.` };
    }
  }

  if (salle_id) {
    const { rows: chevaucheSalle } = await pool.query(
      `SELECT cr.id, cr.matiere, cl.nom AS classe_nom FROM creneaux cr
       JOIN classes cl ON cl.id = cr.classe_id
       WHERE cr.salle_id = $1 AND ${filtreJour.replace("date_exceptionnelle", "cr.date_exceptionnelle").replace("jour_semaine", "cr.jour_semaine")}
         AND cr.heure_debut < $4 AND cr.heure_fin > $3`,
      [salle_id, valeurJour, heure_debut, heure_fin]
    );
    if (chevaucheSalle.length > 0) {
      return { erreur: `Cette salle est déjà occupée par "${chevaucheSalle[0].matiere}" (${chevaucheSalle[0].classe_nom}) sur ce créneau.` };
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO creneaux (classe_id, jour_semaine, date_exceptionnelle, heure_debut, heure_fin, matiere, enseignant, salle_id, est_pause)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [classe_id, jour_semaine || null, date_exceptionnelle || null, heure_debut, heure_fin, matiere, enseignant || null, salle_id || null, !!est_pause]
  );
  return { creneau: rows[0] };
}

// GET /api/creneaux?classe_id=...
router.get("/", async (req, res) => {
  const { classe_id } = req.query;
  const { rows } = await pool.query(
    `SELECT cr.*, s.nom AS salle_nom FROM creneaux cr
     LEFT JOIN salles s ON s.id = cr.salle_id
     WHERE cr.classe_id = $1 ORDER BY cr.jour_semaine, cr.heure_debut`,
    [classe_id]
  );
  res.json(rows);
});

// POST /api/creneaux  { classe_id, jour_semaine, heure_debut, heure_fin, matiere, enseignant }
router.post("/", requireRole("direction", "super_admin"), async (req, res) => {
  const { classe_id } = req.body;
  if (req.user.ecole_id && classe_id) {
    const { rows } = await pool.query("SELECT ecole_id FROM classes WHERE id = $1", [classe_id]);
    if (!rows[0] || rows[0].ecole_id !== req.user.ecole_id) {
      return res.status(403).json({ error: "Cette classe n'appartient pas à ton école." });
    }
  }
  const resultat = await creerCreneauValide(req.body);
  if (resultat.erreur) return res.status(409).json({ error: resultat.erreur });
  res.status(201).json(resultat.creneau);
});

// POST /api/creneaux/import  (fichier Excel/CSV + champ classe_id)
// Colonnes attendues : jour (nom en français, ex. "Lundi"), heure_debut (HH:MM),
// heure_fin (HH:MM), matiere, enseignant (optionnel), salle (optionnel, nom exact).
router.post("/import", requireRole("direction", "super_admin"), upload.single("fichier"), async (req, res) => {
  const { classe_id } = req.body;
  if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu (champ \"fichier\" attendu)." });
  if (!classe_id) return res.status(400).json({ error: "classe_id requis." });

  if (req.user.ecole_id) {
    const { rows } = await pool.query("SELECT ecole_id FROM classes WHERE id = $1", [classe_id]);
    if (!rows[0] || rows[0].ecole_id !== req.user.ecole_id) {
      return res.status(403).json({ error: "Cette classe n'appartient pas à ton école." });
    }
  }

  let lignes;
  try {
    const classeur = XLSX.read(req.file.buffer, { type: "buffer" });
    const feuille = classeur.Sheets[classeur.SheetNames[0]];
    lignes = XLSX.utils.sheet_to_json(feuille, { defval: "" });
  } catch {
    return res.status(400).json({ error: "Fichier illisible — vérifie que c'est bien un .xlsx ou .csv valide." });
  }
  if (lignes.length === 0) return res.status(400).json({ error: "Le fichier ne contient aucune ligne de données." });

  const JOURS_NOMS = { "lundi": 1, "mardi": 2, "mercredi": 3, "jeudi": 4, "vendredi": 5, "samedi": 6, "dimanche": 7 };

  function normaliserCle(k) {
    return k.toString().trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  function valeur(ligne, ...cles) {
    const entree = Object.entries(ligne).find(([k]) => cles.includes(normaliserCle(k)));
    return entree ? String(entree[1]).trim() : "";
  }
  function formatHeure(v) {
    // Excel peut donner une heure sous forme de fraction de journée (ex. 0.354166...) plutôt qu'un texte
    if (typeof v === "number") {
      const minutesTotal = Math.round(v * 24 * 60);
      return `${String(Math.floor(minutesTotal / 60)).padStart(2, "0")}:${String(minutesTotal % 60).padStart(2, "0")}`;
    }
    return v.trim();
  }

  const { rows: sallesEcole } = await pool.query("SELECT id, nom FROM salles WHERE ecole_id = $1", [req.user.ecole_id || null]);
  const salleParNom = new Map(sallesEcole.map((s) => [s.nom.trim().toLowerCase(), s.id]));

  const crees = [];
  const erreurs = [];

  for (let i = 0; i < lignes.length; i++) {
    const ligne = lignes[i];
    const numeroLigne = i + 2;

    const jourTexte = valeur(ligne, "jour").toLowerCase();
    const heureDebut = formatHeure(valeur(ligne, "heure_debut", "heure debut", "debut") || ligne["heure_debut"] || "");
    const heureFin = formatHeure(valeur(ligne, "heure_fin", "heure fin", "fin") || ligne["heure_fin"] || "");
    const matiere = valeur(ligne, "matiere", "matière");
    const enseignant = valeur(ligne, "enseignant");
    const salleTexte = valeur(ligne, "salle");

    const jourNum = JOURS_NOMS[jourTexte];
    if (!jourNum) { erreurs.push({ ligne: numeroLigne, raison: `Jour "${jourTexte}" invalide (attendu : Lundi, Mardi, ... Dimanche).` }); continue; }
    if (!heureDebut || !heureFin || !matiere) { erreurs.push({ ligne: numeroLigne, raison: "heure_debut, heure_fin et matiere sont requis." }); continue; }

    let salle_id = null;
    if (salleTexte) {
      salle_id = salleParNom.get(salleTexte.toLowerCase()) || null;
      if (!salle_id) { erreurs.push({ ligne: numeroLigne, raison: `Salle "${salleTexte}" introuvable.` }); continue; }
    }

    const resultat = await creerCreneauValide({
      classe_id, jour_semaine: jourNum, heure_debut: heureDebut, heure_fin: heureFin,
      matiere, enseignant: enseignant || null, salle_id,
    });
    if (resultat.erreur) erreurs.push({ ligne: numeroLigne, raison: resultat.erreur });
    else crees.push(resultat.creneau);
  }

  res.status(201).json({ total_lignes: lignes.length, crees: crees.length, erreurs, details_crees: crees });
});

// DELETE /api/creneaux/:id
router.delete("/:id", requireRole("direction", "super_admin"), async (req, res) => {
  await pool.query("DELETE FROM creneaux WHERE id = $1", [req.params.id]);
  res.status(204).send();
});

// --------------------------------------------------------------------------
// POST /api/creneaux/generer-auto
// Génère automatiquement les créneaux des classes d'une école, en répartissant
// les matières de chaque enseignant sur les classes qui lui sont rattachées,
// sans jamais créer de chevauchement (ni pour la classe, ni pour l'enseignant).
//
// IMPORTANT — à savoir avant d'utiliser cette fonction :
// C'est un générateur "au mieux", pas un solveur parfait. Il remplit les
// créneaux disponibles dans l'ordre où il les rencontre ; il ne cherche pas
// la répartition optimale (ex. éviter les grands trous, équilibrer les
// journées). Certaines séances peuvent rester "non planifiées" si aucun
// créneau libre commun n'existe — la réponse te dit lesquelles, à traiter
// à la main. Relis toujours l'emploi du temps généré avant de le diffuser.
//
// body: { classe_ids?: [...], jours?: [1..5], duree_minutes?: 55, seances_par_matiere?: 2 }
// Sans classe_ids : génère pour toutes les classes de l'école qui n'ont pas
// encore de créneaux. La "vacation" de chaque classe (matin/après-midi/toute
// la journée) détermine sa plage horaire.
// --------------------------------------------------------------------------
router.post("/generer-auto", requireRole("direction", "super_admin"), async (req, res) => {
  const jours = req.body.jours && req.body.jours.length ? req.body.jours : [1, 2, 3, 4, 5];
  const dureeMinutes = req.body.duree_minutes || 55;
  const seancesParMatiere = req.body.seances_par_matiere || 2;

  // Récupère les horaires de démarrage propres à l'école (configurés dans "Écoles"),
  // au lieu d'horaires fixes identiques pour tout le monde.
  const ecoleIdPourHoraires = ecoleEffective(req);
  const { rows: ecoleRows } = await pool.query(
    `SELECT heure_debut_matin, heure_fin_matin, heure_debut_apresmidi, heure_fin_apresmidi,
            heure_debut_recre, heure_fin_recre, heure_debut_recre_apresmidi, heure_fin_recre_apresmidi
     FROM ecoles WHERE id = $1`,
    [ecoleIdPourHoraires]
  );
  const horaires = ecoleRows[0] || {};
  const fmt = (t, defaut) => (t ? t.toString().slice(0, 5) : defaut);
  const recreMatinDebut = horaires.heure_debut_recre ? fmt(horaires.heure_debut_recre) : null;
  const recreMatinFin = horaires.heure_fin_recre ? fmt(horaires.heure_fin_recre) : null;
  const recreApresMidiDebut = horaires.heure_debut_recre_apresmidi ? fmt(horaires.heure_debut_recre_apresmidi) : null;
  const recreApresMidiFin = horaires.heure_fin_recre_apresmidi ? fmt(horaires.heure_fin_recre_apresmidi) : null;

  const PLAGES = {
    matin: { debut: fmt(horaires.heure_debut_matin, "07:30"), fin: fmt(horaires.heure_fin_matin, "12:30") },
    apres_midi: { debut: fmt(horaires.heure_debut_apresmidi, "13:00"), fin: fmt(horaires.heure_fin_apresmidi, "18:00") },
  };

  function genererSlotsPourPlage(plage) {
    const [hD, mD] = plage.debut.split(":").map(Number);
    const [hF, mF] = plage.fin.split(":").map(Number);
    let minutes = hD * 60 + mD;
    const finMinutes = hF * 60 + mF;
    const slots = [];
    while (minutes + dureeMinutes <= finMinutes) {
      const debut = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      const finSlot = `${String(Math.floor((minutes + dureeMinutes) / 60)).padStart(2, "0")}:${String((minutes + dureeMinutes) % 60).padStart(2, "0")}`;
      // Ne propose jamais un créneau qui chevauche une récréation (matin OU après-midi
      // selon la plage concernée). Au lieu de simplement ignorer ce créneau et avancer
      // par pas fixe (ce qui laisserait un grand trou inutilisé autour d'une courte
      // pause), on reprend directement à la fin exacte de la récréation.
      const chevaucheRecreMatin = recreMatinDebut && recreMatinFin && debut < recreMatinFin && finSlot > recreMatinDebut;
      const chevaucheRecreApresMidi = recreApresMidiDebut && recreApresMidiFin && debut < recreApresMidiFin && finSlot > recreApresMidiDebut;
      if (chevaucheRecreMatin || chevaucheRecreApresMidi) {
        const finRecre = chevaucheRecreMatin ? recreMatinFin : recreApresMidiFin;
        const [hR, mR] = finRecre.split(":").map(Number);
        minutes = hR * 60 + mR;
        continue;
      }
      slots.push({ debut, fin: finSlot });
      minutes += dureeMinutes;
    }
    return slots;
  }

  function genererCreneauxPossibles(vacation) {
    // Une classe en "matin" ou "après-midi" (double vacation) ne reçoit que sa propre plage.
    // Une classe en journée normale (vacation vide) reçoit les DEUX blocs séparément —
    // jamais un seul bloc continu qui traverserait la pause déjeuner sans s'arrêter.
    if (vacation === "matin") return genererSlotsPourPlage(PLAGES.matin);
    if (vacation === "apres_midi") return genererSlotsPourPlage(PLAGES.apres_midi);
    return [...genererSlotsPourPlage(PLAGES.matin), ...genererSlotsPourPlage(PLAGES.apres_midi)];
  }

  // Récupère les classes ciblées, de l'école de l'utilisateur uniquement
  const ecoleGeneration = ecoleEffective(req);
  const paramsClasses = [];
  let filtreEcole = "TRUE";
  if (ecoleGeneration) { paramsClasses.push(ecoleGeneration); filtreEcole = `ecole_id = $${paramsClasses.length}`; }
  let filtreClasses = filtreEcole;
  if (req.body.classe_ids && req.body.classe_ids.length) {
    paramsClasses.push(req.body.classe_ids);
    filtreClasses += ` AND id = ANY($${paramsClasses.length})`;
  }
  const { rows: classesCibles } = await pool.query(`SELECT * FROM classes WHERE ${filtreClasses}`, paramsClasses);

  // Occupation en mémoire pendant la génération : "jour-heure-classe", "jour-heure-enseignant"
  // et "jour-heure-salle" — une salle ne peut jamais accueillir deux classes en même temps.
  const occupeClasse = new Set();
  const occupeEnseignant = new Set();
  const occupeSalle = new Set();

  // Salles disponibles pour cette école (attribution "au mieux", en tournant sur la liste)
  const paramsSalles = [];
  let filtreEcoleSalles = "TRUE";
  if (ecoleGeneration) { paramsSalles.push(ecoleGeneration); filtreEcoleSalles = "ecole_id = $1"; }
  const { rows: sallesEcole } = await pool.query(`SELECT * FROM salles WHERE ${filtreEcoleSalles}`, paramsSalles);

  // Pré-charge les créneaux déjà existants (pour ne pas les écraser ni entrer en conflit avec eux)
  const { rows: existants } = await pool.query(
    `SELECT cr.* FROM creneaux cr JOIN classes cl ON cl.id = cr.classe_id WHERE ${filtreEcole.replace("ecole_id", "cl.ecole_id")}`,
    ecoleGeneration ? [ecoleGeneration] : []
  );
  for (const c of existants) {
    // PostgreSQL renvoie une colonne TIME au format "HH:MM:SS" (avec les secondes),
    // alors que les nouveaux créneaux générés utilisent "HH:MM" (sans secondes) —
    // sans cette normalisation, un créneau déjà créé lors d'un précédent clic sur
    // "Générer automatiquement" n'était jamais reconnu comme occupé, et se retrouvait
    // dupliqué à chaque nouveau clic.
    const heureDebutCourte = c.heure_debut?.slice(0, 5);
    occupeClasse.add(`${c.classe_id}|${c.jour_semaine}|${heureDebutCourte}`);
    if (c.enseignant) occupeEnseignant.add(`${c.enseignant}|${c.jour_semaine}|${heureDebutCourte}`);
    if (c.salle_id) occupeSalle.add(`${c.salle_id}|${c.jour_semaine}|${heureDebutCourte}`);
  }

  const creees = [];
  const nonPlanifiees = [];

  // Détermine le cycle (1er/2nd) à partir du niveau d'une classe — sert de repli
  // quand aucun volume horaire n'est précisé pour ce niveau exact.
  const NIVEAUX_1ER_CYCLE = ["6ème", "5ème", "4ème", "3ème"];
  const NIVEAUX_2ND_CYCLE = ["2nde", "1ère", "Terminale"];
  const normaliseSimple = (s) => (s || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  function cycleDeNiveau(niveau) {
    const n = normaliseSimple(niveau);
    if (NIVEAUX_1ER_CYCLE.some((x) => normaliseSimple(x) === n)) return "1er_cycle";
    if (NIVEAUX_2ND_CYCLE.some((x) => normaliseSimple(x) === n)) return "2nd_cycle";
    return null;
  }

  // Volumes horaires déclarés pour cette école
  const { rows: volumesRows } = await pool.query(
    `SELECT vh.classe_id, vh.niveau, vh.cycle, vh.heures_semaine, m.nom AS matiere_nom
     FROM volumes_horaires vh JOIN matieres m ON m.id = vh.matiere_id
     WHERE ${ecoleGeneration ? "vh.ecole_id = $1" : "TRUE"}`,
    ecoleGeneration ? [ecoleGeneration] : []
  );
  // Comparaison tolérante aux espaces, majuscules ET accents — évite qu'une simple
  // différence de frappe (ex. "6EME" saisi sans accent au lieu de "6ème") empêche
  // silencieusement la correspondance avec le volume horaire configuré.
  const normalise = (s) => (s || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  function heuresPourMatiere(nomMatiere, niveau, classeId) {
    // Priorité du plus précis au plus général : classe exacte > niveau > cycle.
    const parClasse = volumesRows.find((v) => normalise(v.matiere_nom) === normalise(nomMatiere) && v.classe_id === classeId);
    if (parClasse) return Number(parClasse.heures_semaine);
    const parNiveau = volumesRows.find((v) => normalise(v.matiere_nom) === normalise(nomMatiere) && !v.classe_id && normalise(v.niveau) === normalise(niveau));
    if (parNiveau) return Number(parNiveau.heures_semaine);
    const cycle = cycleDeNiveau(niveau);
    const parCycle = volumesRows.find((v) => normalise(v.matiere_nom) === normalise(nomMatiere) && !v.classe_id && !v.niveau && v.cycle === cycle);
    if (parCycle) return Number(parCycle.heures_semaine);
    return null; // aucun volume déclaré — on retombe sur seances_par_matiere par défaut
  }

  // Informations des matières de cette école : catégorie (scientifique/littéraire —
  // pour ne jamais faire se suivre deux matières de la même catégorie), et si la
  // matière doit toujours être programmée sur 2h d'affilée en un seul bloc (ex. EPS).
  const { rows: matieresRows } = await pool.query(
    `SELECT nom, categorie, duree_double FROM matieres WHERE ${ecoleGeneration ? "ecole_id = $1" : "TRUE"}`,
    ecoleGeneration ? [ecoleGeneration] : []
  );
  const infoMatiereParNom = new Map(matieresRows.map((m) => [normalise(m.nom), m]));
  function infoMatiere(nom) { return infoMatiereParNom.get(normalise(nom)) || {}; }

  // Empêche deux matières de la MÊME catégorie de se suivre directement dans la
  // journée d'une classe — repère les créneaux déjà posés (existants + ceux créés
  // pendant cette génération) juste avant/après le créneau candidat.
  const blocsParClasseJour = new Map(); // clé "classeId|jour" -> [{debut, fin, categorie}]
  function ajouterBloc(classeId, jour, debut, fin, categorie) {
    const cle = `${classeId}|${jour}`;
    if (!blocsParClasseJour.has(cle)) blocsParClasseJour.set(cle, []);
    blocsParClasseJour.get(cle).push({ debut, fin, categorie: categorie || null });
  }
  function categorieVoisineConflit(classeId, jour, debut, fin, categorie) {
    if (!categorie) return false; // matière sans catégorie déclarée -> aucune contrainte
    const blocs = blocsParClasseJour.get(`${classeId}|${jour}`) || [];
    return blocs.some((b) => b.categorie === categorie && (b.fin === debut || b.debut === fin));
  }
  for (const c of existants) {
    const heureDebutCourte = c.heure_debut?.slice(0, 5);
    const heureFinCourte = c.heure_fin?.slice(0, 5);
    ajouterBloc(c.classe_id, c.jour_semaine, heureDebutCourte, heureFinCourte, infoMatiere(c.matiere).categorie);
  }

  // Insère automatiquement la récréation dans chaque classe générée, un jour donné —
  // celle du matin pour les classes qui ont classe le matin (vacation "matin" ou
  // journée normale), celle de l'après-midi pour celles qui ont classe l'après-midi
  // (vacation "apres_midi" ou journée normale). Une classe en vacation "matin" ne
  // reçoit JAMAIS la récréation d'après-midi, et inversement — elle n'est
  // physiquement pas présente à ce moment-là.
  for (const classe of classesCibles) {
    const recresApplicables = [];
    if ((classe.vacation === "matin" || !classe.vacation) && recreMatinDebut && recreMatinFin) {
      recresApplicables.push({ debut: recreMatinDebut, fin: recreMatinFin });
    }
    if ((classe.vacation === "apres_midi" || !classe.vacation) && recreApresMidiDebut && recreApresMidiFin) {
      recresApplicables.push({ debut: recreApresMidiDebut, fin: recreApresMidiFin });
    }
    for (const recre of recresApplicables) {
      for (const jour of jours) {
        const clefClasse = `${classe.id}|${jour}|${recre.debut}`;
        if (occupeClasse.has(clefClasse)) continue; // déjà une récréation (ou autre chose) à cette heure
        const { rows } = await pool.query(
          `INSERT INTO creneaux (classe_id, jour_semaine, heure_debut, heure_fin, matiere, est_pause)
           VALUES ($1,$2,$3,$4,'Récréation', true) RETURNING *`,
          [classe.id, jour, recre.debut, recre.fin]
        );
        occupeClasse.add(clefClasse);
        creees.push(rows[0]);
      }
    }
  }

  // Insère de la même façon une pause déjeuner visible entre le matin et l'après-midi,
  // pour les classes en journée normale uniquement (une classe en simple vacation
  // matin OU après-midi n'a pas cette coupure à afficher, elle finit sa journée avant).
  const dejeunerDebut = fmt(horaires.heure_fin_matin, "12:30");
  const dejeunerFin = fmt(horaires.heure_debut_apresmidi, "13:00");
  if (dejeunerDebut !== dejeunerFin) {
    for (const classe of classesCibles) {
      if (classe.vacation) continue; // classes à vacation simple : pas de pause déjeuner à marquer
      for (const jour of jours) {
        const clefClasse = `${classe.id}|${jour}|${dejeunerDebut}`;
        if (occupeClasse.has(clefClasse)) continue;
        const { rows } = await pool.query(
          `INSERT INTO creneaux (classe_id, jour_semaine, heure_debut, heure_fin, matiere, est_pause)
           VALUES ($1,$2,$3,$4,'Pause déjeuner', true) RETURNING *`,
          [classe.id, jour, dejeunerDebut, dejeunerFin]
        );
        occupeClasse.add(clefClasse);
        creees.push(rows[0]);
      }
    }
  }

  for (const classe of classesCibles) {
    // Construit les créneaux disponibles pour cette classe, REGROUPÉS PAR JOUR — pour
    // pouvoir répartir "au maximum 1 séance de chaque matière par jour" avant d'en
    // autoriser une deuxième le même jour (une classe n'a pas besoin de 3h d'affilée
    // de la même matière, mieux vaut étaler sur plusieurs jours différents).
    const slotsParJour = {};
    for (const jour of jours) {
      slotsParJour[jour] = genererCreneauxPossibles(classe.vacation).map((s) => ({ jour, ...s }));
    }

    // Enseignants rattachés à cette classe, avec leurs matières déclarées
    const { rows: enseignants } = await pool.query(
      `SELECT u.id, u.nom, u.matieres FROM users u
       JOIN enseignant_classes ec ON ec.user_id = u.id
       WHERE ec.classe_id = $1 AND u.matieres IS NOT NULL`,
      [classe.id]
    );

    // Si PLUSIEURS enseignants de cette classe partagent la même matière (ex. un
    // vacataire vient compléter un permanent), le volume horaire total de cette
    // matière est RÉPARTI entre eux — pas dupliqué en entier pour chacun. Les
    // premiers de la liste reçoivent l'éventuelle séance restante en cas de
    // répartition non ronde (ex. 5h pour 2 enseignants -> 3h et 2h).
    const enseignantsParMatiere = {};
    for (const e of enseignants) {
      for (const m of e.matieres.split(",").map((x) => x.trim()).filter(Boolean)) {
        if (!enseignantsParMatiere[m]) enseignantsParMatiere[m] = [];
        enseignantsParMatiere[m].push(e.nom);
      }
    }

    // Compteur de rotation : chaque matière commence sa recherche sur un JOUR DIFFÉRENT
    // (au lieu de toujours démarrer par le lundi) — répartit les matières sur toute la
    // semaine au lieu de les entasser en début de semaine.
    let rotation = 0;

    for (const ens of enseignants) {
      // Disponibilités déclarées pour CET enseignant (surtout utile pour les vacataires) —
      // s'il n'en a AUCUNE, il est considéré disponible en permanence (comportement par
      // défaut, ne change rien pour les enseignants déjà configurés sans disponibilités).
      const { rows: disponibilites } = await pool.query(
        "SELECT jour_semaine, heure_debut, heure_fin FROM disponibilites_enseignants WHERE user_id = $1",
        [ens.id]
      );
      function estDisponible(jour, debut, fin) {
        if (disponibilites.length === 0) return true; // aucune contrainte déclarée
        return disponibilites.some((d) =>
          d.jour_semaine === jour && d.heure_debut.slice(0, 5) <= debut && fin <= d.heure_fin.slice(0, 5)
        );
      }

      const matieres = ens.matieres.split(",").map((m) => m.trim()).filter(Boolean);
      for (const matiere of matieres) {
        const infoM = infoMatiere(matiere);
        const categorieMatiere = infoM.categorie || null;
        const estDureeDouble = !!infoM.duree_double;

        // Le volume horaire déclaré (par classe précise, sinon niveau, sinon cycle) prévaut
        // sur la valeur par défaut passée en paramètre — s'il n'y en a pas, on garde l'ancien comportement.
        const heures = heuresPourMatiere(matiere, classe.niveau, classe.id);
        // Pour une matière à durée double (ex. EPS), chaque "séance" dure 2× la durée
        // normale — le nombre de séances visé se calcule donc sur cette base-là.
        const dureeUneSeance = estDureeDouble ? dureeMinutes * 2 : dureeMinutes;
        const seancesTotal = heures != null
          ? Math.max(1, Math.round(heures / (dureeUneSeance / 60)))
          : (estDureeDouble ? Math.max(1, Math.round(seancesParMatiere / 2)) : seancesParMatiere);

        // Répartition entre les enseignants qui partagent cette matière pour cette classe.
        const partageants = enseignantsParMatiere[matiere] || [ens.nom];
        const nbPartageants = partageants.length;
        const indexEnseignant = partageants.indexOf(ens.nom);
        const part = Math.floor(seancesTotal / nbPartageants);
        const reste = seancesTotal % nbPartageants;
        const seancesCible = part + (indexEnseignant < reste ? 1 : 0);

        let placees = 0;
        const placeesParJour = {}; // jour -> nombre de séances de CETTE matière déjà casées aujourd'hui
        // "tour" 0 : au plus 1 séance par jour sur toute la semaine ; si le nombre de
        // séances visé dépasse le nombre de jours disponibles, "tour" 1 autorise une
        // 2ème séance par jour (sur des jours différents en priorité), etc.
        for (let tour = 0; placees < seancesCible && tour < jours.length + 2; tour++) {
          for (let i = 0; i < jours.length && placees < seancesCible; i++) {
            const jour = jours[(rotation + i) % jours.length];
            if ((placeesParJour[jour] || 0) > tour) continue; // ce jour a déjà eu sa part pour ce tour

            const slotsDuJour = slotsParJour[jour] || [];

            if (estDureeDouble) {
              // Cherche DEUX créneaux consécutifs libres (le second commence exactement
              // quand le premier finit) pour former un seul bloc de 2h — jamais fractionné.
              let place = false;
              for (let k = 0; k < slotsDuJour.length - 1 && !place; k++) {
                const s1 = slotsDuJour[k];
                const s2 = slotsDuJour[k + 1];
                if (s1.fin !== s2.debut) continue; // pas vraiment consécutifs (ex. de part et d'autre d'une récré)

                const clefClasse1 = `${classe.id}|${jour}|${s1.debut}`;
                const clefClasse2 = `${classe.id}|${jour}|${s2.debut}`;
                const clefEns1 = `${ens.nom}|${jour}|${s1.debut}`;
                const clefEns2 = `${ens.nom}|${jour}|${s2.debut}`;
                if (occupeClasse.has(clefClasse1) || occupeClasse.has(clefClasse2)) continue;
                if (occupeEnseignant.has(clefEns1) || occupeEnseignant.has(clefEns2)) continue;
                if (!estDisponible(jour, s1.debut, s1.fin) || !estDisponible(jour, s2.debut, s2.fin)) continue;
                if (categorieVoisineConflit(classe.id, jour, s1.debut, s2.fin, categorieMatiere)) continue;

                let salleChoisie = null;
                for (const salle of sallesEcole) {
                  const libre1 = !occupeSalle.has(`${salle.id}|${jour}|${s1.debut}`);
                  const libre2 = !occupeSalle.has(`${salle.id}|${jour}|${s2.debut}`);
                  if (libre1 && libre2) { salleChoisie = salle; break; }
                }

                const { rows } = await pool.query(
                  `INSERT INTO creneaux (classe_id, jour_semaine, heure_debut, heure_fin, matiere, enseignant, salle_id)
                   VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
                  [classe.id, jour, s1.debut, s2.fin, matiere, ens.nom, salleChoisie?.id || null]
                );
                occupeClasse.add(clefClasse1); occupeClasse.add(clefClasse2);
                occupeEnseignant.add(clefEns1); occupeEnseignant.add(clefEns2);
                if (salleChoisie) {
                  occupeSalle.add(`${salleChoisie.id}|${jour}|${s1.debut}`);
                  occupeSalle.add(`${salleChoisie.id}|${jour}|${s2.debut}`);
                }
                ajouterBloc(classe.id, jour, s1.debut, s2.fin, categorieMatiere);
                creees.push(rows[0]);
                placees++;
                placeesParJour[jour] = (placeesParJour[jour] || 0) + 1;
                place = true;
              }
              continue; // passe au jour suivant (place=true ou aucune paire trouvée ce jour)
            }

            for (const slot of slotsDuJour) {
              const clefClasse = `${classe.id}|${slot.jour}|${slot.debut}`;
              const clefEnseignant = `${ens.nom}|${slot.jour}|${slot.debut}`;
              if (occupeClasse.has(clefClasse) || occupeEnseignant.has(clefEnseignant)) continue;
              if (!estDisponible(slot.jour, slot.debut, slot.fin)) continue; // hors des disponibilités déclarées
              if (categorieVoisineConflit(classe.id, slot.jour, slot.debut, slot.fin, categorieMatiere)) continue; // matière de même catégorie juste avant/après

              // Cherche une salle libre à ce créneau précis (au mieux — si aucune salle
              // n'est déclarée pour l'école, le créneau est simplement créé sans salle).
              let salleChoisie = null;
              for (const salle of sallesEcole) {
                const clefSalle = `${salle.id}|${slot.jour}|${slot.debut}`;
                if (!occupeSalle.has(clefSalle)) { salleChoisie = salle; break; }
              }

              const { rows } = await pool.query(
                `INSERT INTO creneaux (classe_id, jour_semaine, heure_debut, heure_fin, matiere, enseignant, salle_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
                [classe.id, slot.jour, slot.debut, slot.fin, matiere, ens.nom, salleChoisie?.id || null]
              );
              occupeClasse.add(clefClasse);
              occupeEnseignant.add(clefEnseignant);
              if (salleChoisie) occupeSalle.add(`${salleChoisie.id}|${slot.jour}|${slot.debut}`);
              ajouterBloc(classe.id, slot.jour, slot.debut, slot.fin, categorieMatiere);
              creees.push(rows[0]);
              placees++;
              placeesParJour[jour] = (placeesParJour[jour] || 0) + 1;
              break; // une seule séance placée pour ce jour à ce tour — passe au jour suivant
            }
          }
        }
        rotation++; // la matière suivante démarre sur un jour différent

        if (placees < seancesCible) {
          nonPlanifiees.push({ classe: classe.nom, matiere, enseignant: ens.nom, manquantes: seancesCible - placees });
        }
      }
    }
  }

  res.status(201).json({ creees: creees.length, details_crees: creees, non_planifiees: nonPlanifiees });
});

module.exports = router;
