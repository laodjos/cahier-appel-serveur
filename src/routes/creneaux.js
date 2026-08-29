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
  const { classe_id, jour_semaine, date_exceptionnelle, heure_debut, heure_fin, matiere, enseignant, salle_id } = req.body;
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
    `INSERT INTO creneaux (classe_id, jour_semaine, date_exceptionnelle, heure_debut, heure_fin, matiere, enseignant, salle_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [classe_id, jour_semaine || null, date_exceptionnelle || null, heure_debut, heure_fin, matiere, enseignant || null, salle_id || null]
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
    "SELECT heure_debut_matin, heure_fin_matin, heure_debut_apresmidi, heure_fin_apresmidi FROM ecoles WHERE id = $1",
    [ecoleIdPourHoraires]
  );
  const horaires = ecoleRows[0] || {};
  const fmt = (t, defaut) => (t ? t.toString().slice(0, 5) : defaut);

  const PLAGES = {
    matin: { debut: fmt(horaires.heure_debut_matin, "07:30"), fin: fmt(horaires.heure_fin_matin, "12:30") },
    apres_midi: { debut: fmt(horaires.heure_debut_apresmidi, "13:00"), fin: fmt(horaires.heure_fin_apresmidi, "18:00") },
    null: { debut: fmt(horaires.heure_debut_matin, "07:30"), fin: fmt(horaires.heure_fin_apresmidi, "17:00") },
  };

  function genererCreneauxPossibles(vacation) {
    const plage = PLAGES[vacation || "null"];
    const [hD, mD] = plage.debut.split(":").map(Number);
    const [hF, mF] = plage.fin.split(":").map(Number);
    let minutes = hD * 60 + mD;
    const finMinutes = hF * 60 + mF;
    const slots = [];
    while (minutes + dureeMinutes <= finMinutes) {
      const debut = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      const finSlot = `${String(Math.floor((minutes + dureeMinutes) / 60)).padStart(2, "0")}:${String((minutes + dureeMinutes) % 60).padStart(2, "0")}`;
      slots.push({ debut, fin: finSlot });
      minutes += dureeMinutes;
    }
    return slots;
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

  for (const classe of classesCibles) {
    const slotsPossibles = [];
    for (const jour of jours) {
      for (const s of genererCreneauxPossibles(classe.vacation)) {
        slotsPossibles.push({ jour, ...s });
      }
    }

    // Enseignants rattachés à cette classe, avec leurs matières déclarées
    const { rows: enseignants } = await pool.query(
      `SELECT u.nom, u.matieres FROM users u
       JOIN enseignant_classes ec ON ec.user_id = u.id
       WHERE ec.classe_id = $1 AND u.matieres IS NOT NULL`,
      [classe.id]
    );

    for (const ens of enseignants) {
      const matieres = ens.matieres.split(",").map((m) => m.trim()).filter(Boolean);
      for (const matiere of matieres) {
        let placees = 0;
        for (const slot of slotsPossibles) {
          if (placees >= seancesParMatiere) break;
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
        if (placees < seancesParMatiere) {
          nonPlanifiees.push({ classe: classe.nom, matiere, enseignant: ens.nom, manquantes: seancesParMatiere - placees });
        }
      }
    }
  }

  res.status(201).json({ creees: creees.length, details_crees: creees, non_planifiees: nonPlanifiees });
});

module.exports = router;
