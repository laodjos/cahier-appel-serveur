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
// Adaptateurs d'envoi réel — appelés uniquement par le job d'envoi (scheduler.js).
// --------------------------------------------------------------------------

// Orange SMS API (Côte d'Ivoire) — voir https://developer.orange.com/apis/sms-ci
// Le jeton d'accès expire au bout d'une heure ; on le met en cache et on ne le
// redemande que lorsqu'il est sur le point d'expirer.
let jetonOrange = null;
let jetonOrangeExpiration = 0;

async function obtenirJetonOrange() {
  if (jetonOrange && Date.now() < jetonOrangeExpiration) return jetonOrange;

  const enTeteAutorisation = process.env.ORANGE_SMS_AUTHORIZATION_HEADER;
  if (!enTeteAutorisation) throw new Error("ORANGE_SMS_AUTHORIZATION_HEADER n'est pas configuré (voir .env.example).");

  const reponse = await axios.post(
    "https://api.orange.com/oauth/v3/token",
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: enTeteAutorisation,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
    }
  );
  jetonOrange = reponse.data.access_token;
  // On redemande un peu avant l'expiration réelle (marge de sécurité de 60s).
  jetonOrangeExpiration = Date.now() + (Number(reponse.data.expires_in || 3600) - 60) * 1000;
  return jetonOrange;
}

// Nettoie un numéro de téléphone ivoirien saisi sous toutes les formes courantes
// ("07 00 00 00 00", "0700000000", "+2250700000000", "225 07 00 00 00 00")
// vers le format attendu par Orange : indicatif + numéro, sans "+" ni "00" ni espace.
function normaliserNumeroCi(numero) {
  let n = (numero || "").replace(/[^\d]/g, ""); // ne garde que les chiffres
  if (n.startsWith("00225")) n = n.slice(2); // "00225..." -> "225..."
  if (n.startsWith("225")) n = `225${n.slice(3).replace(/^0/, "")}`; // retire un éventuel 0 après l'indicatif
  else n = `225${n.replace(/^0/, "")}`; // pas d'indicatif du tout -> l'ajoute
  return n;
}

async function envoyerViaOrangeSms(numeroTelephone, message) {
  if (!numeroTelephone) throw new Error("Aucun numéro de téléphone renseigné pour ce parent.");
  const numeroExpediteur = process.env.ORANGE_SMS_SENDER_NUMBER; // ex. "2250000000" (fourni par Orange)
  if (!numeroExpediteur) throw new Error("ORANGE_SMS_SENDER_NUMBER n'est pas configuré (voir .env.example).");

  const jeton = await obtenirJetonOrange();
  const destinataire = normaliserNumeroCi(numeroTelephone);

  await axios.post(
    `https://api.orange.com/smsmessaging/v1/outbound/tel:+${numeroExpediteur}/requests`,
    {
      outboundSMSMessageRequest: {
        address: `tel:+${destinataire}`,
        senderAddress: `tel:+${numeroExpediteur}`,
        outboundSMSTextMessage: { message },
      },
    },
    { headers: { Authorization: `Bearer ${jeton}`, "Content-Type": "application/json" } }
  );
}

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

// Envoie la notification au parent — par SMS par défaut (aucune application
// mobile n'existe actuellement pour recevoir un push). Le jour où une
// application mobile existera, il suffira de repasser NOTIFICATION_PROVIDER à
// "expo" ou "fcm" dans les variables d'environnement, sans toucher au reste du code.
async function envoyerNotification(parent, message) {
  const provider = process.env.NOTIFICATION_PROVIDER || "sms";
  if (provider === "fcm") return envoyerViaFcm(parent.push_token, message);
  if (provider === "expo") return envoyerViaExpo(parent.push_token, message);
  return envoyerViaOrangeSms(parent.telephone, message);
}

module.exports = {
  programmerNotificationPresence,
  programmerEnvoiRapport,
  envoyerNotification,
};
