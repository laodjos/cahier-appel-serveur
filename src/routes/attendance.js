const express = require("express");
const { pool } = require("../config/db");
const { authRequired } = require("../middleware/auth");
const { verifierJeton } = require("../services/qrService");
const { programmerNotificationPresence } = require("../services/notificationService");

const router = express.Router();
router.use(authRequired);

// Pour un Super-administrateur en train de consulter une école précise
// (envoyée en ?ecole_id=... par le sélecteur d'école du frontend).
function ecoleEffective(req) {
  if (req.user.ecole_id) return req.user.ecole_id;
  return req.query?.ecole_id || req.body?.ecole_id || null;
}

// --------------------------------------------------------------------------
// POST /api/attendance/qr-scan  { token, creneau_id }
// Appelé par l'appli tablette/smartphone de l'enseignant quand un badge est scanné.
// --------------------------------------------------------------------------
router.post("/qr-scan", async (req, res) => {
  const { token, creneau_id } = req.body;
  if (!token) return res.status(400).json({ error: "QR code illisible ou vide." });

  const payload = verifierJeton(token);
  if (!payload || payload.typ !== "badge_eleve") {
    return res.status(400).json({ error: "Badge QR invalide." });
  }

  // Vérifie que le jeton scanné correspond bien au jeton actuellement enregistré
  // pour cet élève (permet de révoquer un badge perdu en le régénérant).
  const { rows: studentRows } = await pool.query(
    "SELECT * FROM students WHERE id = $1 AND qr_token = $2",
    [payload.sid, token]
  );
  const student = studentRows[0];
  if (!student) return res.status(400).json({ error: "Badge QR révoqué ou inconnu." });

  const statut = "present"; // le scan en classe vaut présence ; la logique de retard peut comparer à l'heure du créneau si besoin
  const { rows } = await pool.query(
    `INSERT INTO attendance_events (student_id, creneau_id, source, statut)
     VALUES ($1, $2, 'qr', $3) RETURNING *`,
    [student.id, creneau_id || null, statut]
  );

  await programmerNotificationPresence(student.id, statut);
  res.status(201).json({ event: rows[0], eleve: { id: student.id, nom: student.nom } });
});

// --------------------------------------------------------------------------
// POST /api/attendance/manual  { student_id, creneau_id, statut }
// Correction manuelle par l'enseignant/surveillant (secours si lecteur en panne).
// --------------------------------------------------------------------------
router.post("/manual", async (req, res) => {
  const { student_id, creneau_id, statut } = req.body;
  if (!student_id || !["present", "retard", "absent"].includes(statut)) {
    return res.status(400).json({ error: "student_id et statut (present|retard|absent) requis." });
  }
  const { rows } = await pool.query(
    `INSERT INTO attendance_events (student_id, creneau_id, source, statut, saisi_par)
     VALUES ($1, $2, 'manuel', $3, $4) RETURNING *`,
    [student_id, creneau_id || null, statut, req.user.sub]
  );
  if (statut !== "absent") await programmerNotificationPresence(student_id, statut);
  res.status(201).json(rows[0]);
});

// --------------------------------------------------------------------------
// GET /api/attendance/registre?classe_id=&creneau_id=&date=YYYY-MM-DD
// Dernier statut du jour pour chaque élève d'une classe (utilisé par l'écran Appel).
// --------------------------------------------------------------------------
router.get("/registre", async (req, res) => {
  const { classe_id, date } = req.query;
  const jour = date || new Date().toISOString().slice(0, 10);

  const { rows } = await pool.query(
    `SELECT s.id AS student_id, s.nom, s.classe_id,
            (SELECT statut FROM attendance_events ae
             WHERE ae.student_id = s.id AND ae.horodatage::date = $2
             ORDER BY ae.horodatage DESC LIMIT 1) AS statut
     FROM students s
     WHERE s.classe_id = $1
     ORDER BY s.nom`,
    [classe_id, jour]
  );
  res.json(rows.map((r) => ({ ...r, statut: r.statut || "attente" })));
});

// --------------------------------------------------------------------------
// GET /api/attendance/registre-jour?date=YYYY-MM-DD
// Registre complet de TOUTES les classes de l'école pour un jour donné —
// utilisé pour le rapport "Registre d'appel journalier" (export PDF).
// --------------------------------------------------------------------------
router.get("/registre-jour", async (req, res) => {
  const jour = req.query.date || new Date().toISOString().slice(0, 10);
  const params = [jour];
  let filtreEcole = "TRUE";
  const ecoleId = ecoleEffective(req);
  if (ecoleId) { params.push(ecoleId); filtreEcole = `c.ecole_id = $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT s.nom, c.nom AS classe_nom, c.niveau,
            (SELECT statut FROM attendance_events ae
             WHERE ae.student_id = s.id AND ae.horodatage::date = $1
             ORDER BY ae.horodatage DESC LIMIT 1) AS statut
     FROM students s
     JOIN classes c ON c.id = s.classe_id
     WHERE ${filtreEcole}
     ORDER BY c.niveau NULLS LAST, c.nom, s.nom`,
    params
  );
  res.json({ date: jour, eleves: rows.map((r) => ({ ...r, statut: r.statut || "attente" })) });
});

// --------------------------------------------------------------------------
// GET /api/attendance/stats/today  -> compteurs pour le tableau de bord (école de l'utilisateur)
// --------------------------------------------------------------------------
router.get("/stats/today", async (req, res) => {
  const params = [];
  let filtreEcole = "TRUE";
  const ecoleId = ecoleEffective(req); if (ecoleId) { params.push(ecoleId); filtreEcole = `c.ecole_id = $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT ae.statut, COUNT(DISTINCT ae.student_id) AS total
     FROM attendance_events ae
     JOIN students s ON s.id = ae.student_id
     LEFT JOIN classes c ON c.id = s.classe_id
     WHERE ae.horodatage::date = CURRENT_DATE AND ${filtreEcole}
     GROUP BY ae.statut`,
    params
  );
  const counts = { present: 0, retard: 0, absent: 0 };
  rows.forEach((r) => { counts[r.statut] = Number(r.total); });

  const { rows: totalRows } = await pool.query(
    `SELECT COUNT(*) AS total FROM students s LEFT JOIN classes c ON c.id = s.classe_id WHERE ${filtreEcole}`,
    params
  );
  res.json({ ...counts, total_eleves: Number(totalRows[0].total) });
});

// --------------------------------------------------------------------------
// GET /api/attendance/absenteisme?seuil=3  -> élèves à risque ce mois-ci (école de l'utilisateur)
// --------------------------------------------------------------------------
router.get("/absenteisme", async (req, res) => {
  const seuil = Number(req.query.seuil) || 3;
  const params = [seuil];
  let filtreEcole = "TRUE";
  const ecoleId = ecoleEffective(req); if (ecoleId) { params.push(ecoleId); filtreEcole = `c.ecole_id = $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT s.id, s.nom, c.nom AS classe_nom, COUNT(*) AS absences_mois
     FROM attendance_events ae
     JOIN students s ON s.id = ae.student_id
     LEFT JOIN classes c ON c.id = s.classe_id
     WHERE ae.statut = 'absent' AND date_trunc('month', ae.horodatage) = date_trunc('month', CURRENT_DATE) AND ${filtreEcole}
     GROUP BY s.id, s.nom, c.nom
     HAVING COUNT(*) >= $1
     ORDER BY absences_mois DESC`,
    params
  );
  res.json(rows);
});

// --------------------------------------------------------------------------
// POST /api/attendance/valider-appel  { classe_id, creneau_id? }
// Finalise l'appel "par exception" : tout élève de la classe qui n'a encore
// aucun pointage aujourd'hui (pour ce créneau) est officiellement marqué
// "présent" — seuls ceux déjà marqués "absent" manuellement gardent ce statut.
// C'est cette validation qui rend l'appel visible/complet dans les statistiques
// (et qui permet de détecter les créneaux où l'appel n'a PAS été fait du tout).
// --------------------------------------------------------------------------
router.post("/valider-appel", async (req, res) => {
  const { classe_id, creneau_id } = req.body;
  if (!classe_id) return res.status(400).json({ error: "classe_id requis." });

  const { rows: eleves } = await pool.query("SELECT id FROM students WHERE classe_id = $1", [classe_id]);

  let completes = 0;
  for (const eleve of eleves) {
    const { rows: existant } = await pool.query(
      `SELECT 1 FROM attendance_events
       WHERE student_id = $1 AND horodatage::date = CURRENT_DATE
         AND creneau_id ${creneau_id ? "= $2" : "IS NULL"}`,
      creneau_id ? [eleve.id, creneau_id] : [eleve.id]
    );
    if (existant.length === 0) {
      await pool.query(
        `INSERT INTO attendance_events (student_id, creneau_id, source, statut, saisi_par)
         VALUES ($1, $2, 'manuel', 'present', $3)`,
        [eleve.id, creneau_id || null, req.user.sub]
      );
      completes++;
    }
  }
  res.status(201).json({ total_eleves: eleves.length, marques_presents: completes });
});

// --------------------------------------------------------------------------
// GET /api/attendance/creneaux-sans-appel?date=YYYY-MM-DD
// Liste les créneaux déjà terminés aujourd'hui pour lesquels AUCUN pointage
// n'a été enregistré dans la classe — signe que l'enseignant n'a pas fait
// l'appel (et probablement absent, ou l'a oublié).
// --------------------------------------------------------------------------
router.get("/creneaux-sans-appel", async (req, res) => {
  const jour = req.query.date || new Date().toISOString().slice(0, 10);
  const jourSemaine = new Date(jour + "T12:00:00").getDay() || 7; // dimanche=0 -> 7, lundi=1...

  const params = [jourSemaine];
  let filtreEcole = "TRUE";
  const ecoleId = ecoleEffective(req);
  if (ecoleId) { params.push(ecoleId); filtreEcole = `cl.ecole_id = $${params.length}`; }

  const { rows: ferie } = await pool.query("SELECT 1 FROM jours_non_scolaires WHERE date = $1", [jour]);
  const estFerie = ferie.length > 0;

  // Créneaux récurrents normaux (ignorés si jour férié) + créneaux de rattrapage
  // exceptionnels prévus CE jour précis (comptés même un jour férié — c'est tout
  // l'intérêt d'un rattrapage volontaire). Un créneau compte dès que son heure de
  // début + 15 minutes de tolérance est dépassée — pas besoin d'attendre qu'il soit
  // terminé pour alerter la Direction, pendant qu'il est encore temps d'agir
  // (appeler l'enseignant, envoyer un remplaçant...).
  const paramsJour = [...params, jour];
  const { rows: creneauxDuJour } = await pool.query(
    `SELECT cr.*, cl.nom AS classe_nom,
            (cr.heure_fin < to_char(now(), 'HH24:MI')::time) AS termine
     FROM creneaux cr
     JOIN classes cl ON cl.id = cr.classe_id
     WHERE ${filtreEcole}
       AND (cr.heure_debut + interval '15 minutes') < to_char(now(), 'HH24:MI')::time
       AND cr.est_pause = false
       AND (
         (cr.jour_semaine = $1 AND cr.date_exceptionnelle IS NULL ${estFerie ? "AND FALSE" : ""})
         OR cr.date_exceptionnelle = $${paramsJour.length}
       )
     ORDER BY cr.heure_debut`,
    paramsJour
  );

  const resultats = [];
  for (const cr of creneauxDuJour) {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS total FROM attendance_events ae
       JOIN students s ON s.id = ae.student_id
       WHERE s.classe_id = $1 AND ae.creneau_id = $2 AND ae.horodatage::date = $3`,
      [cr.classe_id, cr.id, jour]
    );
    if (Number(rows[0].total) === 0) resultats.push(cr);
  }
  res.json(resultats);
});

// --------------------------------------------------------------------------
// GET /api/attendance/suivi-enseignants?debut=YYYY-MM-DD&fin=YYYY-MM-DD
// Rapport sur une période : pour chaque enseignant, compte les créneaux où
// AUCUN appel n'a été fait (donc probablement absent) et le total d'heures
// correspondant — utile pour ajuster la paie dans un établissement où les
// enseignants sont payés à l'heure effectivement travaillée.
// --------------------------------------------------------------------------
router.get("/suivi-enseignants", async (req, res) => {
  const aujourdHui = new Date().toISOString().slice(0, 10);
  const debut = req.query.debut || aujourdHui.slice(0, 8) + "01"; // 1er du mois courant par défaut
  const fin = req.query.fin || aujourdHui;

  const params = [];
  let filtreEcole = "TRUE";
  const ecoleId = ecoleEffective(req);
  if (ecoleId) { params.push(ecoleId); filtreEcole = `cl.ecole_id = $${params.length}`; }

  const { rows: creneauxEcole } = await pool.query(
    `SELECT cr.*, cl.nom AS classe_nom FROM creneaux cr JOIN classes cl ON cl.id = cr.classe_id WHERE ${filtreEcole} AND cr.enseignant IS NOT NULL AND cr.est_pause = false`,
    params
  );
  const { rows: joursFeries } = await pool.query(
    "SELECT date FROM jours_non_scolaires WHERE date BETWEEN $1 AND $2", [debut, fin]
  );
  const feriesSet = new Set(joursFeries.map((j) => j.date.toISOString().slice(0, 10)));

  const parEnseignant = {}; // { nom: { absences: n, minutes: n, details: [...] } }
  const maintenant = new Date();

  let curseur = new Date(debut + "T00:00:00");
  const dateFin = new Date(fin + "T00:00:00");
  while (curseur <= dateFin) {
    const jourStr = curseur.toISOString().slice(0, 10);
    const jourSemaineCurseur = curseur.getDay() || 7;
    const estFerie = feriesSet.has(jourStr);

    for (const cr of creneauxEcole) {
      // Créneau récurrent normal : ignoré les jours fériés, et seulement si c'est le bon jour de la semaine.
      const estRecurrentDuJour = cr.jour_semaine === jourSemaineCurseur && !cr.date_exceptionnelle && !estFerie;
      // Créneau de rattrapage exceptionnel : compte SEULEMENT à sa date précise, férié ou pas.
      const estRattrapageDuJour = cr.date_exceptionnelle && cr.date_exceptionnelle.toISOString().slice(0, 10) === jourStr;
      if (!estRecurrentDuJour && !estRattrapageDuJour) continue;

      // Ignore les créneaux pas encore terminés si c'est aujourd'hui
      const finCreneauDatetime = new Date(`${jourStr}T${cr.heure_fin}`);
      if (finCreneauDatetime > maintenant) continue;

      const { rows } = await pool.query(
        `SELECT COUNT(*) AS total FROM attendance_events ae
         JOIN students s ON s.id = ae.student_id
         WHERE s.classe_id = $1 AND ae.creneau_id = $2 AND ae.horodatage::date = $3`,
        [cr.classe_id, cr.id, jourStr]
      );
      if (Number(rows[0].total) === 0) {
        const [hD, mD] = cr.heure_debut.split(":").map(Number);
        const [hF, mF] = cr.heure_fin.split(":").map(Number);
        const duree = (hF * 60 + mF) - (hD * 60 + mD);
        if (!parEnseignant[cr.enseignant]) parEnseignant[cr.enseignant] = { enseignant: cr.enseignant, absences: 0, minutes: 0, details: [] };
        parEnseignant[cr.enseignant].absences++;
        parEnseignant[cr.enseignant].minutes += duree;
        parEnseignant[cr.enseignant].details.push({ date: jourStr, classe: cr.classe_nom, matiere: cr.matiere, heure_debut: cr.heure_debut, heure_fin: cr.heure_fin });
      }
    }
    curseur.setDate(curseur.getDate() + 1);
  }

  const resultat = Object.values(parEnseignant)
    .map((e) => ({ ...e, heures: Math.round((e.minutes / 60) * 100) / 100 }))
    .sort((a, b) => b.minutes - a.minutes);

  res.json({ debut, fin, enseignants: resultat });
});

// --------------------------------------------------------------------------
// GET /api/attendance/paye-enseignants?debut=YYYY-MM-DD&fin=YYYY-MM-DD
// Calcule la paie de chaque enseignant sur une période : heures RÉELLEMENT
// travaillées (appel fait) × son taux horaire — les heures sans appel (absence,
// déjà repérées par /suivi-enseignants) ne sont jamais payées. Un enseignant
// sans taux horaire renseigné apparaît quand même, avec le montant marqué
// comme non calculable, pour qu'il ne soit pas oublié du rapport.
// --------------------------------------------------------------------------
router.get("/paye-enseignants", async (req, res) => {
  const aujourdHui = new Date().toISOString().slice(0, 10);
  const debut = req.query.debut || aujourdHui.slice(0, 8) + "01";
  const fin = req.query.fin || aujourdHui;

  const params = [];
  let filtreEcole = "TRUE";
  const ecoleId = ecoleEffective(req);
  if (ecoleId) { params.push(ecoleId); filtreEcole = `cl.ecole_id = $${params.length}`; }

  const { rows: creneauxEcole } = await pool.query(
    `SELECT cr.*, cl.nom AS classe_nom FROM creneaux cr JOIN classes cl ON cl.id = cr.classe_id WHERE ${filtreEcole} AND cr.enseignant IS NOT NULL AND cr.est_pause = false`,
    params
  );
  const { rows: joursFeries } = await pool.query(
    "SELECT date FROM jours_non_scolaires WHERE date BETWEEN $1 AND $2", [debut, fin]
  );
  const feriesSet = new Set(joursFeries.map((j) => j.date.toISOString().slice(0, 10)));

  // Taux horaire, statut et salaire de chaque enseignant (recherche par nom, comme
  // le reste du système de créneaux qui stocke le nom de l'enseignant en texte libre).
  const paramsProfs = [];
  let filtreEcoleProfs = "TRUE";
  if (ecoleId) { paramsProfs.push(ecoleId); filtreEcoleProfs = `ecole_id = $${paramsProfs.length}`; }
  const { rows: profs } = await pool.query(
    `SELECT nom, taux_horaire, statut_emploi, salaire_base, heures_mensuelles_reference, parts_fiscales, cycle_enseignement FROM users WHERE role = 'enseignant' AND ${filtreEcoleProfs}`,
    paramsProfs
  );
  const infoProfParNom = new Map(profs.map((p) => [p.nom, p]));

  const parEnseignant = {};
  const maintenant = new Date();

  let curseur = new Date(debut + "T00:00:00");
  const dateFin = new Date(fin + "T00:00:00");
  while (curseur <= dateFin) {
    const jourStr = curseur.toISOString().slice(0, 10);
    const jourSemaineCurseur = curseur.getDay() || 7;
    const estFerie = feriesSet.has(jourStr);

    for (const cr of creneauxEcole) {
      const estRecurrentDuJour = cr.jour_semaine === jourSemaineCurseur && !cr.date_exceptionnelle && !estFerie;
      const estRattrapageDuJour = cr.date_exceptionnelle && cr.date_exceptionnelle.toISOString().slice(0, 10) === jourStr;
      if (!estRecurrentDuJour && !estRattrapageDuJour) continue;

      const finCreneauDatetime = new Date(`${jourStr}T${cr.heure_fin}`);
      if (finCreneauDatetime > maintenant) continue; // pas encore terminé — pas encore comptabilisable

      if (!parEnseignant[cr.enseignant]) {
        const info = infoProfParNom.get(cr.enseignant) || {};
        parEnseignant[cr.enseignant] = {
          enseignant: cr.enseignant,
          statut_emploi: info.statut_emploi || null,
          taux_horaire: info.taux_horaire != null ? Number(info.taux_horaire) : null,
          salaire_base: info.salaire_base != null ? Number(info.salaire_base) : null,
          heures_mensuelles_reference: info.heures_mensuelles_reference != null ? Number(info.heures_mensuelles_reference) : null,
          parts_fiscales: info.parts_fiscales != null ? Number(info.parts_fiscales) : 1,
          cycle_enseignement: info.cycle_enseignement || null,
          minutes_travaillees: 0,
          minutes_manquees: 0,
          minutesParJourTravaillees: [], // pour répartir normales/supplémentaires semaine par semaine
        };
      }

      const { rows } = await pool.query(
        `SELECT COUNT(*) AS total FROM attendance_events ae
         JOIN students s ON s.id = ae.student_id
         WHERE s.classe_id = $1 AND ae.creneau_id = $2 AND ae.horodatage::date = $3`,
        [cr.classe_id, cr.id, jourStr]
      );

      const [hD, mD] = cr.heure_debut.split(":").map(Number);
      const [hF, mF] = cr.heure_fin.split(":").map(Number);
      const duree = (hF * 60 + mF) - (hD * 60 + mD);

      if (Number(rows[0].total) > 0) {
        parEnseignant[cr.enseignant].minutes_travaillees += duree;
        parEnseignant[cr.enseignant].minutesParJourTravaillees.push({ date: jourStr, jourSemaine: jourSemaineCurseur, minutes: duree });
      } else {
        parEnseignant[cr.enseignant].minutes_manquees += duree;
      }
    }
    curseur.setDate(curseur.getDate() + 1);
  }

  // --------------------------------------------------------------------------
  // Calcul CNPS/ITS partagé (voir services/payrollService.js) — impôt unique
  // en vigueur depuis la réforme du 1er janvier 2024. ⚠ À faire vérifier
  // périodiquement par un comptable, les taux pouvant changer par loi de finances.
  // --------------------------------------------------------------------------
  const { calculerBulletin, repartirNormalesEtSupplementaires } = require("../services/payrollService");

  const resultat = Object.values(parEnseignant)
    .map((e) => {
      const heures_travaillees = Math.round((e.minutes_travaillees / 60) * 100) / 100;
      const heures_manquees = Math.round((e.minutes_manquees / 60) * 100) / 100;

      // Un enseignant PERMANENT avec un salaire de base renseigné : calcul complet
      // (salaire réel - déduction des heures manquées, puis CNPS + ITS).
      if (e.statut_emploi === "permanent" && e.salaire_base != null && e.heures_mensuelles_reference) {
        // Sépare les heures normales (dans le plafond réglementaire hebdomadaire) des
        // heures supplémentaires — seulement si le cycle d'enseignement est renseigné.
        const { minutes_normales, minutes_supplementaires } = repartirNormalesEtSupplementaires(e.minutesParJourTravaillees, e.cycle_enseignement);
        const heures_supplementaires = Math.round((minutes_supplementaires / 60) * 100) / 100;

        const valeurHeure = e.salaire_base / e.heures_mensuelles_reference;
        const deduction_absences = Math.round(heures_manquees * valeurHeure);
        const salaire_base_ajuste = Math.max(0, e.salaire_base - deduction_absences);
        // Les heures supplémentaires sont payées EN PLUS, au taux horaire déclaré —
        // elles s'ajoutent au brut avant CNPS/ITS (elles sont, elles aussi, imposables).
        const montant_heures_supp = e.taux_horaire != null ? Math.round(heures_supplementaires * e.taux_horaire) : 0;
        const salaire_brut_ajuste = salaire_base_ajuste + montant_heures_supp;
        const { cnps, its_net, net: montant_a_payer } = calculerBulletin(salaire_brut_ajuste, e.parts_fiscales);
        return {
          enseignant: e.enseignant,
          statut_emploi: e.statut_emploi,
          heures_travaillees,
          heures_manquees,
          heures_supplementaires,
          mode_calcul: "salaire_reel",
          salaire_base: e.salaire_base,
          deduction_absences,
          montant_heures_supp,
          salaire_brut_ajuste,
          cnps,
          its_net,
          montant_a_payer,
        };
      }

      // Sinon (vacataire, ou permanent sans salaire renseigné) : calcul simple heures × taux horaire.
      const montant_a_payer = e.taux_horaire != null ? Math.round(heures_travaillees * e.taux_horaire) : null;
      return {
        enseignant: e.enseignant,
        statut_emploi: e.statut_emploi,
        taux_horaire: e.taux_horaire,
        heures_travaillees,
        heures_manquees,
        mode_calcul: "taux_horaire",
        montant_a_payer,
      };
    })
    .sort((a, b) => (b.montant_a_payer || 0) - (a.montant_a_payer || 0));

  const total_a_payer = resultat.reduce((somme, e) => somme + (e.montant_a_payer || 0), 0);

  res.json({ debut, fin, enseignants: resultat, total_a_payer });
});

// --------------------------------------------------------------------------
// GET /api/attendance/bulletin-salaire/:userId?debut=&fin=
// Bulletin de salaire individuel — fonctionne pour N'IMPORTE QUEL membre
// (Direction, Surveillant, ou Enseignant), pas seulement les enseignants :
//   - Enseignant PERMANENT avec salaire renseigné : même calcul que la paie
//     collective (salaire réel - heures manquées, puis CNPS + ITS).
//   - Enseignant VACATAIRE (ou permanent sans salaire renseigné) : heures
//     travaillées × taux horaire, sans CNPS/ITS (rémunération à l'acte).
//   - Direction / Surveillant (administration) : salaire fixe mensuel, sans
//     notion d'heures manquées (pas de créneaux à leur nom) — CNPS + ITS
//     directement sur le salaire de base.
// --------------------------------------------------------------------------
router.get("/bulletin-salaire/:userId", async (req, res) => {
  const { calculerBulletin } = require("../services/payrollService");
  const aujourdHui = new Date().toISOString().slice(0, 10);
  const debut = req.query.debut || aujourdHui.slice(0, 8) + "01";
  const fin = req.query.fin || aujourdHui;

  const params = [req.params.userId];
  let filtreEcole = "TRUE";
  const ecoleId = ecoleEffective(req);
  if (ecoleId) { params.push(ecoleId); filtreEcole = `ecole_id = $${params.length}`; }

  const { rows: userRows } = await pool.query(
    `SELECT * FROM users WHERE id = $1 AND ${filtreEcole}`, params
  );
  const personne = userRows[0];
  if (!personne) return res.status(404).json({ error: "Compte introuvable (ou hors de ton école)." });

  // --- Cas 1 : administration (Direction, Surveillant, Super-administrateur) ---
  if (personne.role !== "enseignant") {
    if (personne.salaire_base == null) {
      return res.json({ debut, fin, personne: { nom: personne.nom, role: personne.role }, mode_calcul: "non_renseigne" });
    }
    const { cnps, its_net, net } = calculerBulletin(Number(personne.salaire_base), personne.parts_fiscales || 1);
    return res.json({
      debut, fin,
      personne: { nom: personne.nom, role: personne.role },
      mode_calcul: "salaire_reel",
      salaire_base: Number(personne.salaire_base),
      deduction_absences: 0,
      salaire_brut_ajuste: Number(personne.salaire_base),
      cnps, its_net, montant_a_payer: net,
    });
  }

  // --- Cas 2 : enseignant — réutilise le même calcul jour par jour que la paie collective ---
  const paramsEcole = [];
  let filtreEcoleCr = "TRUE";
  if (ecoleId) { paramsEcole.push(ecoleId); filtreEcoleCr = `cl.ecole_id = $${paramsEcole.length}`; }
  const { rows: creneauxEcole } = await pool.query(
    `SELECT cr.*, cl.nom AS classe_nom FROM creneaux cr JOIN classes cl ON cl.id = cr.classe_id
     WHERE ${filtreEcoleCr} AND cr.enseignant = $${paramsEcole.length + 1} AND cr.est_pause = false`,
    [...paramsEcole, personne.nom]
  );
  const { rows: joursFeries } = await pool.query(
    "SELECT date FROM jours_non_scolaires WHERE date BETWEEN $1 AND $2", [debut, fin]
  );
  const feriesSet = new Set(joursFeries.map((j) => j.date.toISOString().slice(0, 10)));

  let minutes_travaillees = 0;
  let minutes_manquees = 0;
  const minutesParJourTravaillees = [];
  const maintenant = new Date();
  let curseur = new Date(debut + "T00:00:00");
  const dateFin = new Date(fin + "T00:00:00");
  while (curseur <= dateFin) {
    const jourStr = curseur.toISOString().slice(0, 10);
    const jourSemaineCurseur = curseur.getDay() || 7;
    const estFerie = feriesSet.has(jourStr);

    for (const cr of creneauxEcole) {
      const estRecurrentDuJour = cr.jour_semaine === jourSemaineCurseur && !cr.date_exceptionnelle && !estFerie;
      const estRattrapageDuJour = cr.date_exceptionnelle && cr.date_exceptionnelle.toISOString().slice(0, 10) === jourStr;
      if (!estRecurrentDuJour && !estRattrapageDuJour) continue;
      const finCreneauDatetime = new Date(`${jourStr}T${cr.heure_fin}`);
      if (finCreneauDatetime > maintenant) continue;

      const { rows } = await pool.query(
        `SELECT COUNT(*) AS total FROM attendance_events ae
         JOIN students s ON s.id = ae.student_id
         WHERE s.classe_id = $1 AND ae.creneau_id = $2 AND ae.horodatage::date = $3`,
        [cr.classe_id, cr.id, jourStr]
      );
      const [hD, mD] = cr.heure_debut.split(":").map(Number);
      const [hF, mF] = cr.heure_fin.split(":").map(Number);
      const duree = (hF * 60 + mF) - (hD * 60 + mD);
      if (Number(rows[0].total) > 0) {
        minutes_travaillees += duree;
        minutesParJourTravaillees.push({ date: jourStr, jourSemaine: jourSemaineCurseur, minutes: duree });
      } else {
        minutes_manquees += duree;
      }
    }
    curseur.setDate(curseur.getDate() + 1);
  }

  const heures_travaillees = Math.round((minutes_travaillees / 60) * 100) / 100;
  const heures_manquees = Math.round((minutes_manquees / 60) * 100) / 100;

  if (personne.statut_emploi === "permanent" && personne.salaire_base != null && personne.heures_mensuelles_reference) {
    const { repartirNormalesEtSupplementaires } = require("../services/payrollService");
    const { minutes_supplementaires } = repartirNormalesEtSupplementaires(minutesParJourTravaillees, personne.cycle_enseignement);
    const heures_supplementaires = Math.round((minutes_supplementaires / 60) * 100) / 100;

    const valeurHeure = Number(personne.salaire_base) / Number(personne.heures_mensuelles_reference);
    const deduction_absences = Math.round(heures_manquees * valeurHeure);
    const salaire_base_ajuste = Math.max(0, Number(personne.salaire_base) - deduction_absences);
    const montant_heures_supp = personne.taux_horaire != null ? Math.round(heures_supplementaires * Number(personne.taux_horaire)) : 0;
    const salaire_brut_ajuste = salaire_base_ajuste + montant_heures_supp;
    const { cnps, its_net, net } = calculerBulletin(salaire_brut_ajuste, personne.parts_fiscales || 1);
    return res.json({
      debut, fin,
      personne: { nom: personne.nom, role: personne.role },
      mode_calcul: "salaire_reel",
      heures_travaillees, heures_manquees, heures_supplementaires,
      salaire_base: Number(personne.salaire_base),
      deduction_absences, montant_heures_supp, salaire_brut_ajuste, cnps, its_net,
      montant_a_payer: net,
    });
  }

  // Vacataire (ou permanent sans salaire renseigné) : heures × taux horaire
  const montant_a_payer = personne.taux_horaire != null ? Math.round(heures_travaillees * Number(personne.taux_horaire)) : null;
  res.json({
    debut, fin,
    personne: { nom: personne.nom, role: personne.role },
    mode_calcul: "taux_horaire",
    heures_travaillees, heures_manquees,
    taux_horaire: personne.taux_horaire != null ? Number(personne.taux_horaire) : null,
    montant_a_payer,
  });
});

module.exports = router;
