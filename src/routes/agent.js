const express = require("express");
const { pool } = require("../config/db");
const { authAgent } = require("../middleware/auth");
const { programmerNotificationPresence } = require("../services/notificationService");

const router = express.Router();
router.use(authAgent); // toutes les routes ci-dessous exigent la clé d'agent de l'école

// GET /api/agent/devices — liste des lecteurs de l'école, pour que l'agent sache lesquels interroger
router.get("/devices", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM devices WHERE ecole_id = $1", [req.ecoleAgent.id]);
  res.json(rows);
});

// POST /api/agent/pointage  { matricule, device_id, statut, horodatage }
// Envoyé par l'agent local à chaque pointage détecté sur un lecteur ZKTeco/Hikvision.
router.post("/pointage", async (req, res) => {
  const { matricule, device_id, statut, horodatage } = req.body;
  if (!matricule || !device_id || !horodatage) {
    return res.status(400).json({ error: "matricule, device_id et horodatage sont requis." });
  }

  // Vérifie que le lecteur appartient bien à l'école de cette clé d'agent
  const { rows: deviceRows } = await pool.query(
    "SELECT * FROM devices WHERE id = $1 AND ecole_id = $2", [device_id, req.ecoleAgent.id]
  );
  if (!deviceRows[0]) return res.status(403).json({ error: "Ce lecteur n'appartient pas à ton école." });

  const { rows: studentRows } = await pool.query(
    `SELECT s.id FROM students s JOIN classes c ON c.id = s.classe_id
     WHERE s.matricule = $1 AND c.ecole_id = $2`,
    [matricule, req.ecoleAgent.id]
  );
  if (!studentRows[0]) return res.status(404).json({ ignore: true, error: "Matricule inconnu dans cette école — pointage ignoré." });

  const exists = await pool.query(
    `SELECT 1 FROM attendance_events WHERE student_id = $1 AND device_id = $2 AND horodatage = $3`,
    [studentRows[0].id, device_id, horodatage]
  );
  if (exists.rowCount > 0) return res.json({ ok: true, doublon: true });

  await pool.query(
    `INSERT INTO attendance_events (student_id, source, device_id, statut, horodatage)
     VALUES ($1, $2, $3, $4, $5)`,
    [studentRows[0].id, deviceRows[0].marque, device_id, statut || "present", horodatage]
  );
  await pool.query("UPDATE devices SET en_ligne = true, derniere_synchro = now() WHERE id = $1", [device_id]);
  await programmerNotificationPresence(studentRows[0].id, statut || "present");

  res.status(201).json({ ok: true });
});

// POST /api/agent/incident  { device_id, type, detail }
router.post("/incident", async (req, res) => {
  const { device_id, type, detail } = req.body;
  if (!device_id || !type) return res.status(400).json({ error: "device_id et type sont requis." });
  await pool.query(
    "INSERT INTO device_incidents (device_id, type, detail) VALUES ($1, $2, $3)",
    [device_id, type, detail || null]
  );
  if (type === "deconnecte") await pool.query("UPDATE devices SET en_ligne = false WHERE id = $1", [device_id]);
  res.status(201).json({ ok: true });
});

module.exports = router;
