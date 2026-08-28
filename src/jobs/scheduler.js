const cron = require("node-cron");
const { pool } = require("../config/db");
const { synchroniserLecteurZkteco } = require("../connectors/zktecoConnector");
const { synchroniserLecteurHikvision } = require("../connectors/hikvisionConnector");
const { envoyerNotification } = require("../services/notificationService");

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
      `SELECT n.*, p.push_token FROM notifications n
       JOIN parents p ON p.id = n.parent_id
       WHERE n.statut = 'programmee' AND n.envoyer_a <= now()
       LIMIT 200`
    );
    for (const notif of rows) {
      try {
        await envoyerNotification(notif.push_token, notif.contenu);
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

module.exports = { demarrerPollingLecteurs, demarrerEnvoiNotifications };
