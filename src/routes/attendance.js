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
  // l'intérêt d'un rattrapage volontaire).
  const paramsJour = [...params, jour];
  const { rows: creneauxDuJour } = await pool.query(
    `SELECT cr.*, cl.nom AS classe_nom FROM creneaux cr
     JOIN classes cl ON cl.id = cr.classe_id
     WHERE ${filtreEcole} AND cr.heure_fin < to_char(now(), 'HH24:MI')::time
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
    `SELECT cr.*, cl.nom AS classe_nom FROM creneaux cr JOIN classes cl ON cl.id = cr.classe_id WHERE ${filtreEcole} AND cr.enseignant IS NOT NULL`,
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

module.exports = router;
