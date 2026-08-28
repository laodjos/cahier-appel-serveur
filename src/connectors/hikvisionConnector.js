// Connecteur Hikvision — utilise l'API ISAPI (standard sur les terminaux de contrôle d'accès
// Hikvision) en authentification Digest. On interroge périodiquement l'historique des événements
// d'accès (AcsEvent) plutôt que d'ouvrir un flux permanent, pour rester simple et robuste.

const axios = require("axios");
const { DigestAuth } = require("./digestAuth"); // petite implémentation maison, voir digestAuth.js
const { pool } = require("../config/db");
const { programmerNotificationPresence } = require("../services/notificationService");

async function synchroniserLecteurHikvision(device, identifiants) {
  const { utilisateur, motDePasse } = identifiants;
  const baseUrl = `http://${device.adresse_ip}`;
  const digest = new DigestAuth(utilisateur, motDePasse);

  try {
    // IMPORTANT — spécificité du DS-K1T804AMF (et famille DS-K1T3xx/8xx) :
    // 1) startTime ET endTime sont OBLIGATOIRES, au format avec décalage horaire
    //    explicite (+01:00), PAS le suffixe "Z" que produit toISOString() par défaut —
    //    sinon le terminal répond "Invalid Content" / badParameters.
    // 2) maxResults est plafonné à 10 sur ce modèle (contrairement à d'autres terminaux
    //    Hikvision qui acceptent jusqu'à 30 ou plus) — un plafond plus haut échoue aussi.
    const formatDateAvecFuseau = (date) => {
      const pad = (n) => String(n).padStart(2, "0");
      const offsetMin = -date.getTimezoneOffset();
      const signe = offsetMin >= 0 ? "+" : "-";
      const offsetH = pad(Math.floor(Math.abs(offsetMin) / 60));
      const offsetM = pad(Math.abs(offsetMin) % 60);
      return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${signe}${offsetH}:${offsetM}`
      );
    };

    const depuis = new Date(Date.now() - 5 * 60 * 1000);
    const body = {
      AcsEventCond: {
        searchID: `sync-${Date.now()}`,
        searchResultPosition: 0,
        maxResults: 10, // plafond du DS-K1T804AMF — ne pas augmenter sur ce modèle
        major: 5, // 5 = événements de contrôle d'accès (dont reconnaissance faciale/empreinte réussie)
        minor: 75, // 75 = authentification réussie — confirmé sur cette famille de terminaux (DS-K1T3xx/8xx)
        startTime: formatDateAvecFuseau(depuis),
        endTime: formatDateAvecFuseau(new Date()),
      },
    };

    const response = await digest.request({
      method: "POST",
      url: `${baseUrl}/ISAPI/AccessControl/AcsEvent?format=json`,
      data: body,
    });

    const events = response.data?.AcsEvent?.InfoList || [];
    let nouveaux = 0;

    for (const evt of events) {
      // employeeNoString correspond au matricule saisi lors de l'enrôlement de l'élève sur le terminal
      const matricule = evt.employeeNoString;
      if (!matricule) continue;

      const { rows } = await pool.query("SELECT id FROM students WHERE matricule = $1", [matricule]);
      const student = rows[0];
      if (!student) continue;

      const horodatage = evt.time;
      const exists = await pool.query(
        `SELECT 1 FROM attendance_events WHERE student_id = $1 AND device_id = $2 AND horodatage = $3`,
        [student.id, device.id, horodatage]
      );
      if (exists.rowCount > 0) continue;

      await pool.query(
        `INSERT INTO attendance_events (student_id, source, device_id, statut, horodatage)
         VALUES ($1, 'hikvision', $2, 'present', $3)`,
        [student.id, device.id, horodatage]
      );
      await programmerNotificationPresence(student.id, "present");
      nouveaux++;
    }

    await pool.query("UPDATE devices SET en_ligne = true, derniere_synchro = now() WHERE id = $1", [device.id]);
    return { ok: true, nouveaux };
  } catch (err) {
    // Ne marque PAS hors ligne ici — c'est le planificateur qui décide après plusieurs échecs.
    await pool.query(
      `INSERT INTO device_incidents (device_id, type, detail) VALUES ($1, 'deconnecte', $2)`,
      [device.id, err.message]
    );
    return { ok: false, error: err.message };
  }
}

module.exports = { synchroniserLecteurHikvision };
