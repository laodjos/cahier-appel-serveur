const express = require("express");
const { pool } = require("../config/db");
const { authRequired, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);

function ecoleEffective(req) {
  if (req.user.ecole_id) return req.user.ecole_id;
  return req.query?.ecole_id || req.body?.ecole_id || null;
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
  const { classe_id, jour_semaine, date_exceptionnelle, heure_debut, heure_fin, matiere, enseignant, salle_id, est_pause } = req.body;
  if (!classe_id || (!jour_semaine && !date_exceptionnelle) || !heure_debut || !heure_fin || !matiere) {
    return res.status(400).json({ error: "classe_id, (jour_semaine OU date_exceptionnelle), heure_debut, heure_fin et matiere sont requis." });
  }
  if (heure_fin <= heure_debut) {
    return res.status(400).json({ error: "L'heure de fin doit être après l'heure de début." });
  }
  if (req.user.ecole_id) {
    const { rows } = await pool.query("SELECT ecole_id FROM classes WHERE id = $1", [classe_id]);
    if (!rows[0] || rows[0].ecole_id !== req.user.ecole_id) {
      return res.status(403).json({ error: "Cette classe n'appartient pas à ton école." });
    }
  }

  // Un vrai créneau ne doit jamais se chevaucher avec un autre — la comparaison se fait
  // soit sur le même jour de la semaine (créneau récurrent), soit sur la même date exacte
  // (créneau de rattrapage), selon lequel des deux a été fourni.
  const filtreJour = date_exceptionnelle ? "date_exceptionnelle = $2" : "jour_semaine = $2";
  const valeurJour = date_exceptionnelle || jour_semaine;

  const { rows: chevaucheClasse } = await pool.query(
    `SELECT id, matiere FROM creneaux
     WHERE classe_id = $1 AND ${filtreJour}
       AND heure_debut < $4 AND heure_fin > $3`,
    [classe_id, valeurJour, heure_debut, heure_fin]
  );
  if (chevaucheClasse.length > 0) {
    return res.status(409).json({ error: `Cette classe a déjà "${chevaucheClasse[0].matiere}" sur ce créneau — chevauchement impossible.` });
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
      return res.status(409).json({ error: `${enseignant} donne déjà "${chevaucheEnseignant[0].matiere}" en ${chevaucheEnseignant[0].classe_nom} sur ce créneau.` });
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
      return res.status(409).json({ error: `Cette salle est déjà occupée par "${chevaucheSalle[0].matiere}" (${chevaucheSalle[0].classe_nom}) sur ce créneau.` });
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO creneaux (classe_id, jour_semaine, date_exceptionnelle, heure_debut, heure_fin, matiere, enseignant, salle_id, est_pause)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [classe_id, jour_semaine || null, date_exceptionnelle || null, heure_debut, heure_fin, matiere, enseignant || null, salle_id || null, !!est_pause]
  );
  res.status(201).json(rows[0]);
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
    "SELECT heure_debut_matin, heure_fin_matin, heure_debut_apresmidi, heure_fin_apresmidi, heure_debut_recre, heure_fin_recre FROM ecoles WHERE id = $1",
    [ecoleIdPourHoraires]
  );
  const horaires = ecoleRows[0] || {};
  const fmt = (t, defaut) => (t ? t.toString().slice(0, 5) : defaut);
  const recreDebut = horaires.heure_debut_recre ? fmt(horaires.heure_debut_recre) : null;
  const recreFin = horaires.heure_fin_recre ? fmt(horaires.heure_fin_recre) : null;

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
      // Ne propose jamais un créneau qui chevauche la récréation — elle reste libre pour tout le monde.
      const chevaucheRecre = recreDebut && recreFin && debut < recreFin && finSlot > recreDebut;
      if (!chevaucheRecre) slots.push({ debut, fin: finSlot });
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
    occupeClasse.add(`${c.classe_id}|${c.jour_semaine}|${c.heure_debut}`);
    if (c.enseignant) occupeEnseignant.add(`${c.enseignant}|${c.jour_semaine}|${c.heure_debut}`);
    if (c.salle_id) occupeSalle.add(`${c.salle_id}|${c.jour_semaine}|${c.heure_debut}`);
  }

  const creees = [];
  const nonPlanifiees = [];

  // Détermine le cycle (1er/2nd) à partir du niveau d'une classe — sert de repli
  // quand aucun volume horaire n'est précisé pour ce niveau exact.
  const NIVEAUX_1ER_CYCLE = ["6ème", "5ème", "4ème", "3ème"];
  const NIVEAUX_2ND_CYCLE = ["2nde", "1ère", "Terminale"];
  function cycleDeNiveau(niveau) {
    if (NIVEAUX_1ER_CYCLE.includes(niveau)) return "1er_cycle";
    if (NIVEAUX_2ND_CYCLE.includes(niveau)) return "2nd_cycle";
    return null;
  }

  // Volumes horaires déclarés pour cette école — { "NomMatiere|niveau" -> heures, "NomMatiere|cycle" -> heures }
  const { rows: volumesRows } = await pool.query(
    `SELECT vh.niveau, vh.cycle, vh.heures_semaine, m.nom AS matiere_nom
     FROM volumes_horaires vh JOIN matieres m ON m.id = vh.matiere_id
     WHERE ${ecoleGeneration ? "vh.ecole_id = $1" : "TRUE"}`,
    ecoleGeneration ? [ecoleGeneration] : []
  );
  function heuresPourMatiere(nomMatiere, niveau) {
    const parNiveau = volumesRows.find((v) => v.matiere_nom === nomMatiere && v.niveau === niveau);
    if (parNiveau) return Number(parNiveau.heures_semaine);
    const cycle = cycleDeNiveau(niveau);
    const parCycle = volumesRows.find((v) => v.matiere_nom === nomMatiere && !v.niveau && v.cycle === cycle);
    if (parCycle) return Number(parCycle.heures_semaine);
    return null; // aucun volume déclaré — on retombe sur seances_par_matiere par défaut
  }

  // Insère automatiquement une récréation dans chaque classe générée, un jour donné,
  // si l'école en a une configurée — occupe le créneau pour que rien d'autre n'y soit placé.
  if (recreDebut && recreFin) {
    for (const classe of classesCibles) {
      for (const jour of jours) {
        const clefClasse = `${classe.id}|${jour}|${recreDebut}`;
        if (occupeClasse.has(clefClasse)) continue; // déjà une récréation (ou autre chose) à cette heure
        const { rows } = await pool.query(
          `INSERT INTO creneaux (classe_id, jour_semaine, heure_debut, heure_fin, matiere, est_pause)
           VALUES ($1,$2,$3,$4,'Récréation', true) RETURNING *`,
          [classe.id, jour, recreDebut, recreFin]
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
    // Construit TOUS les créneaux disponibles pour cette classe, semaine entière
    // (matin ET après-midi de chaque jour, à la suite).
    const tousLesSlots = [];
    for (const jour of jours) {
      for (const s of genererCreneauxPossibles(classe.vacation)) {
        tousLesSlots.push({ jour, ...s });
      }
    }

    // Enseignants rattachés à cette classe, avec leurs matières déclarées
    const { rows: enseignants } = await pool.query(
      `SELECT u.nom, u.matieres FROM users u
       JOIN enseignant_classes ec ON ec.user_id = u.id
       WHERE ec.classe_id = $1 AND u.matieres IS NOT NULL`,
      [classe.id]
    );

    // Compteur de rotation : chaque matière commence sa recherche à un POINT DIFFÉRENT
    // de la semaine entière (matin ou après-midi, n'importe quel jour) — au lieu de
    // toujours démarrer par le lundi matin. Ça évite que tout s'entasse le matin des
    // premiers jours en laissant les après-midis systématiquement vides.
    let rotation = 0;

    for (const ens of enseignants) {
      const matieres = ens.matieres.split(",").map((m) => m.trim()).filter(Boolean);
      for (const matiere of matieres) {
        // Le volume horaire déclaré (par niveau, sinon par cycle) prévaut sur la valeur
        // par défaut passée en paramètre — s'il n'y en a pas, on garde l'ancien comportement.
        const heures = heuresPourMatiere(matiere, classe.niveau);
        const seancesCible = heures != null ? Math.max(1, Math.round(heures / (dureeMinutes / 60))) : seancesParMatiere;

        // Fait tourner le POINT DE DÉPART dans la liste complète de la semaine (pas
        // seulement l'ordre des jours) — répartit vraiment matin ET après-midi.
        const decalage = tousLesSlots.length ? rotation % tousLesSlots.length : 0;
        const slotsPossibles = [...tousLesSlots.slice(decalage), ...tousLesSlots.slice(0, decalage)];
        rotation += 3; // pas arbitraire : avance assez pour toucher des créneaux différents à chaque matière

        let placees = 0;
        for (const slot of slotsPossibles) {
          if (placees >= seancesCible) break;
          const clefClasse = `${classe.id}|${slot.jour}|${slot.debut}`;
          const clefEnseignant = `${ens.nom}|${slot.jour}|${slot.debut}`;
          if (occupeClasse.has(clefClasse) || occupeEnseignant.has(clefEnseignant)) continue;

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
          creees.push(rows[0]);
          placees++;
        }
        if (placees < seancesCible) {
          nonPlanifiees.push({ classe: classe.nom, matiere, enseignant: ens.nom, manquantes: seancesCible - placees });
        }
      }
    }
  }

  res.status(201).json({ creees: creees.length, details_crees: creees, non_planifiees: nonPlanifiees });
});

module.exports = router;
