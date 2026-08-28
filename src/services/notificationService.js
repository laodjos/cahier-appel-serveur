// Gère l'envoi des notifications à l'application mobile des parents.
// Deux briques :
//  1. programmerNotificationPresence(...)  -> appelée automatiquement à chaque pointage
//  2. programmerEnvoiRapport(...)          -> appelée depuis l'écran "Rattachement parents"
//     pour un envoi immédiat OU différé (date/heure programmée).
// L'envoi réel est fait par le job cron dispatchNotifications (voir src/jobs/dispatchNotifications.js),
// qui lit la table `notifications` et envoie tout ce dont envoyer_a <= maintenant.

const axios = require("axios");
const { pool } = require("../config/db");

async function getParentsDeEleve(studentId) {
  const { rows } = await pool.query(
    `SELECT p.* FROM parents p
     JOIN student_parents sp ON sp.parent_id = p.id
     WHERE sp.student_id = $1`,
    [studentId]
  );
  return rows;
}

// Appelée à chaque pointage (QR, ZKTeco, Hikvision, manuel) pour prévenir le/les parent(s).
async function programmerNotificationPresence(studentId, statut) {
  const parents = await getParentsDeEleve(studentId);
  if (parents.length === 0) return; // élève non rattaché à un parent : rien à envoyer

  const { rows: sRows } = await pool.query("SELECT nom FROM students WHERE id = $1", [studentId]);
  const nomEleve = sRows[0]?.nom || "Votre enfant";
  const contenu =
    statut === "retard"
      ? `${nomEleve} est arrivé(e) en retard à l'école.`
      : `${nomEleve} est bien arrivé(e) à l'école.`;

  for (const parent of parents) {
    await pool.query(
      `INSERT INTO notifications (student_id, parent_id, type, contenu, statut, envoyer_a)
       VALUES ($1, $2, $3, $4, 'programmee', now())`,
      [studentId, parent.id, statut === "retard" ? "retard" : "presence", contenu]
    );
  }
}

// Appelée depuis la section "Rattachement parents" / "Envoi du rapport".
// mode: "immediat" | "differe" ; dateEnvoi requis si differe (objet Date).
async function programmerEnvoiRapport({ studentIds, type, contenu, mode, dateEnvoi }) {
  const envoyerA = mode === "differe" && dateEnvoi ? dateEnvoi : new Date();
  let count = 0;

  for (const studentId of studentIds) {
    const parents = await getParentsDeEleve(studentId);
    for (const parent of parents) {
      await pool.query(
        `INSERT INTO notifications (student_id, parent_id, type, contenu, statut, envoyer_a)
         VALUES ($1, $2, $3, $4, 'programmee', $5)`,
        [studentId, parent.id, type, contenu, envoyerA]
      );
      count++;
    }
  }
  return count;
}

// --------------------------------------------------------------------------
// Adaptateurs d'envoi réel — appelés uniquement par le job dispatchNotifications.
// --------------------------------------------------------------------------
async function envoyerViaExpo(pushToken, message) {
  // Expo Push API : simple, gratuit, bien adapté à une appli React Native.
  return axios.post("https://exp.host/--/api/v2/push/send", {
    to: pushToken,
    title: "Cahier d'Appel",
    body: message,
    sound: "default",
  });
}

async function envoyerViaFcm(pushToken, message) {
  // Nécessite firebase-admin et le fichier de compte de service (voir .env.example).
  // eslint-disable-next-line global-require
  const admin = require("firebase-admin");
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(require(process.env.FCM_SERVICE_ACCOUNT_JSON_PATH)),
    });
  }
  return admin.messaging().send({
    token: pushToken,
    notification: { title: "Cahier d'Appel", body: message },
  });
}

async function envoyerNotification(pushToken, message) {
  if (!pushToken) throw new Error("Le parent n'a pas encore ouvert l'application mobile (aucun jeton push).");
  const provider = process.env.NOTIFICATION_PROVIDER || "expo";
  return provider === "fcm" ? envoyerViaFcm(pushToken, message) : envoyerViaExpo(pushToken, message);
}

module.exports = {
  programmerNotificationPresence,
  programmerEnvoiRapport,
  envoyerNotification,
};
