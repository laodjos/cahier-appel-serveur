const cron = require("node-cron");
const { pool } = require("../config/db");
const { synchroniserLecteurZkteco } = require("../connectors/zktecoConnector");
const { synchroniserLecteurHikvision } = require("../connectors/hikvisionConnector");
const { envoyerNotification } = require("../services/notificationService");
const { envoyerPushAUtilisateur } = require("../services/pushService");

// Nombre d'échecs consécutifs tolérés avant de déclarer un lecteur "hors ligne" —
// évite qu'une coupure réseau d'une seconde déclenche une fausse alerte à chaque fois.
const ECHECS_AVANT_HORS_LIGNE = 2;
const echecsConsecutifs = new Map(); // device.id -> nombre d'échecs d'affilée

// --------------------------------------------------------------------------
// 1) Interroge tous les lecteurs ZKTeco/Hikvision déclarés en base toutes les 15s
// --------------------------------------------------------------------------
function demarrerPollingLecteurs() {
  const intervalle = Number(process.env.ZKTECO_POLL_INTERVAL_SECONDS) || 15;
  setInterval(async () => {
    const { rows: devices } = await pool.query("SELECT * FROM devices");
    for (const device of devices) {
      let resultat;
      if (device.marque === "zkteco") {
        resultat = await synchroniserLecteurZkteco(device);
      } else if (device.marque === "hikvision") {
        resultat = await synchroniserLecteurHikvision(device, {
          utilisateur: process.env.HIKVISION_1_USER,
          motDePasse: process.env.HIKVISION_1_PASSWORD,
        });
      } else {
        continue;
      }

      if (resultat?.ok) {
        echecsConsecutifs.set(device.id, 0);
      } else {
        const echecs = (echecsConsecutifs.get(device.id) || 0) + 1;
        echecsConsecutifs.set(device.id, echecs);
        if (echecs >= ECHECS_AVANT_HORS_LIGNE) {
          await pool.query("UPDATE devices SET en_ligne = false WHERE id = $1", [device.id]);
        }
        // En dessous du seuil : on ne touche pas au statut affiché, le lecteur reste
        // considéré "en ligne" tant que ce n'est pas confirmé sur plusieurs tentatives.
      }
    }
  }, intervalle * 1000);
  console.log(`⏱  Polling des lecteurs biométriques toutes les ${intervalle}s (tolérance : ${ECHECS_AVANT_HORS_LIGNE} échecs avant alerte)`);
}

// --------------------------------------------------------------------------
// 2) Envoie les notifications dont l'heure programmée est arrivée (immédiat ou différé)
//    Tourne toutes les minutes.
// --------------------------------------------------------------------------
function demarrerEnvoiNotifications() {
  cron.schedule("* * * * *", async () => {
    const { rows } = await pool.query(
      `SELECT n.*, p.telephone, p.push_token FROM notifications n
       JOIN parents p ON p.id = n.parent_id
       WHERE n.statut = 'programmee' AND n.envoyer_a <= now()
       LIMIT 200`
    );
    for (const notif of rows) {
      try {
        await envoyerNotification({ telephone: notif.telephone, push_token: notif.push_token }, notif.contenu);
        await pool.query(
          "UPDATE notifications SET statut = 'envoyee', envoyee_a = now() WHERE id = $1",
          [notif.id]
        );
      } catch (err) {
        await pool.query("UPDATE notifications SET statut = 'echouee' WHERE id = $1", [notif.id]);
        console.error("Échec d'envoi de notification :", notif.id, err.message);
      }
    }
  });
  console.log("⏱  Envoi des notifications programmées : vérification chaque minute");
}

// --------------------------------------------------------------------------
// 3) Rappel "cours dans 15 minutes" aux enseignants abonnés aux notifications
//    push — fonctionne même si l'application n'est pas ouverte à l'écran.
//    Tourne toutes les minutes ; comme les créneaux commencent toujours à une
//    minute ronde, chaque créneau ne déclenche le rappel qu'une seule fois
//    (exactement 15 minutes avant son heure de début).
// --------------------------------------------------------------------------
function demarrerRappelsCoursEnseignants() {
  if (!process.env.VAPID_PUBLIC_KEY) {
    console.log("⏱  Rappels de cours (push) désactivés — VAPID_PUBLIC_KEY non configuré.");
    return;
  }
  cron.schedule("* * * * *", async () => {
    const maintenant = new Date();
    const jourSemaine = maintenant.getDay() || 7;
    const aujourdHui = maintenant.toISOString().slice(0, 10);
    const dans15min = new Date(maintenant.getTime() + 15 * 60000);
    const heureCible = `${String(dans15min.getHours()).padStart(2, "0")}:${String(dans15min.getMinutes()).padStart(2, "0")}`;

    const { rows: creneaux } = await pool.query(
      `SELECT cr.*, cl.nom AS classe_nom, cl.ecole_id, sa.nom AS salle_nom FROM creneaux cr
       JOIN classes cl ON cl.id = cr.classe_id
       LEFT JOIN salles sa ON sa.id = cr.salle_id
       WHERE cr.est_pause = false AND cr.enseignant IS NOT NULL
         AND cr.heure_debut::text LIKE $1 || ':%'
         AND (cr.jour_semaine = $2 OR cr.date_exceptionnelle = $3)`,
      [heureCible, jourSemaine, aujourdHui]
    );

    for (const cr of creneaux) {
      try {
        // Filtre aussi par école pour éviter qu'une homonymie entre deux
        // établissements différents n'envoie le rappel au mauvais enseignant.
        const { rows: profs } = await pool.query(
          "SELECT id FROM users WHERE nom = $1 AND role = 'enseignant' AND ecole_id IS NOT DISTINCT FROM $2",
          [cr.enseignant, cr.ecole_id]
        );
        for (const prof of profs) {
          await envoyerPushAUtilisateur(prof.id, {
            title: "Cours dans 15 minutes",
            body: `${cr.matiere} — ${cr.classe_nom} (${cr.heure_debut?.slice(0,5)}${cr.salle_nom ? `, ${cr.salle_nom}` : ""})`,
          });
        }
      } catch (err) {
        console.error("Échec d'envoi du rappel de cours :", err.message);
      }
    }
  });
  console.log("⏱  Rappels de cours aux enseignants (push) : vérification chaque minute");
}

module.exports = { demarrerPollingLecteurs, demarrerEnvoiNotifications, demarrerRappelsCoursEnseignants };
