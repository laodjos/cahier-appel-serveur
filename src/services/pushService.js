const webpush = require("web-push");
const { pool } = require("../config/db");

let configure = false;
function assurerConfiguration() {
  if (configure) return;
  const clePublique = process.env.VAPID_PUBLIC_KEY;
  const clePrivee = process.env.VAPID_PRIVATE_KEY;
  if (!clePublique || !clePrivee) {
    throw new Error("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY ne sont pas configurés (voir .env.example).");
  }
  webpush.setVapidDetails(
    process.env.VAPID_CONTACT_EMAIL ? `mailto:${process.env.VAPID_CONTACT_EMAIL}` : "mailto:contact@example.com",
    clePublique,
    clePrivee
  );
  configure = true;
}

// Envoie une notification à TOUS les abonnements enregistrés d'un utilisateur
// (il peut être abonné depuis plusieurs appareils). Un abonnement devenu
// invalide (ex. l'utilisateur a désinstallé le navigateur) est automatiquement
// supprimé de la base au lieu d'échouer silencieusement à chaque tentative future.
async function envoyerPushAUtilisateur(userId, payload) {
  assurerConfiguration();
  const { rows: abonnements } = await pool.query(
    "SELECT * FROM push_subscriptions WHERE user_id = $1", [userId]
  );

  for (const abo of abonnements) {
    try {
      await webpush.sendNotification(
        { endpoint: abo.endpoint, keys: { p256dh: abo.p256dh, auth: abo.auth } },
        JSON.stringify(payload)
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        // Abonnement expiré ou révoqué côté navigateur — plus la peine de réessayer.
        await pool.query("DELETE FROM push_subscriptions WHERE id = $1", [abo.id]);
      } else {
        console.error("Échec d'envoi push :", err.message);
      }
    }
  }
}

module.exports = { envoyerPushAUtilisateur };
