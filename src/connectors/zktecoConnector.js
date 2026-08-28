// Connecteur ZKTeco — mode "PULL" : le serveur interroge le lecteur périodiquement
// (plus simple à mettre en place qu'ADMS, pas besoin de configurer le lecteur pour qu'il pousse les données).
// Bibliothèque utilisée : node-zklib (protocole ZKTeco standard, ports 4370).

const ZKLib = require("node-zklib");
const { pool } = require("../config/db");
const { programmerNotificationPresence } = require("../services/notificationService");

async function synchroniserLecteurZkteco(device) {
  // Délais augmentés (15s connexion / 6s réponse) pour tolérer un réseau local plus lent
  // qu'un réseau de bureau classique — réduit les faux "hors ligne" sur wifi ou longue distance.
  const zk = new ZKLib(device.adresse_ip, Number(process.env.ZKTECO_1_PORT) || 4370, 15000, 6000);
  try {
    await zk.createSocket();

    const logs = await zk.getAttendances(); // { data: [{ userSn, deviceUserId, recordTime, ... }] }
    let nouveaux = 0;

    for (const log of logs.data) {
      // deviceUserId correspond au matricule saisi sur le lecteur lors de l'enrôlement de l'élève
      const { rows } = await pool.query("SELECT id FROM students WHERE matricule = $1", [log.deviceUserId]);
      const student = rows[0];
      if (!student) continue; // pointage d'un utilisateur non enregistré côté application — on ignore

      // Évite les doublons : ne réinsère pas un événement déjà connu pour ce même horodatage
      const exists = await pool.query(
        `SELECT 1 FROM attendance_events WHERE student_id = $1 AND device_id = $2 AND horodatage = $3`,
        [student.id, device.id, log.recordTime]
      );
      if (exists.rowCount > 0) continue;

      await pool.query(
        `INSERT INTO attendance_events (student_id, source, device_id, statut, horodatage)
         VALUES ($1, 'zkteco', $2, 'present', $3)`,
        [student.id, device.id, log.recordTime]
      );
      await programmerNotificationPresence(student.id, "present");
      nouveaux++;
    }

    await pool.query(
      "UPDATE devices SET en_ligne = true, derniere_synchro = now() WHERE id = $1",
      [device.id]
    );
    await zk.disconnect();
    return { ok: true, nouveaux };
  } catch (err) {
    // Ne marque PAS hors ligne ici — c'est le planificateur (scheduler.js) qui décide,
    // après plusieurs échecs consécutifs, pour éviter les fausses alertes sur un simple
    // ralentissement réseau passager.
    await pool.query(
      `INSERT INTO device_incidents (device_id, type, detail) VALUES ($1, 'deconnecte', $2)`,
      [device.id, err.message]
    );
    return { ok: false, error: err.message };
  }
}

module.exports = { synchroniserLecteurZkteco };
