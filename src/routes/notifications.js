const express = require("express");
const { pool } = require("../config/db");
const { authRequired, requireRole } = require("../middleware/auth");
const { programmerEnvoiRapport } = require("../services/notificationService");

const router = express.Router();
router.use(authRequired);

// POST /api/notifications/rapport
// { student_ids: [...] (vide = tous les élèves rattachés), mode: "immediat"|"differe", date_envoi, contenu }
router.post("/rapport", requireRole("direction", "surveillant"), async (req, res) => {
  const { student_ids, mode, date_envoi, contenu } = req.body;

  let ids = student_ids;
  if (!ids || ids.length === 0) {
    const { rows } = await pool.query(
      `SELECT DISTINCT s.id FROM students s JOIN student_parents sp ON sp.student_id = s.id`
    );
    ids = rows.map((r) => r.id);
  }

  if (mode === "differe" && !date_envoi) {
    return res.status(400).json({ error: "date_envoi requis pour un envoi différé." });
  }

  const count = await programmerEnvoiRapport({
    studentIds: ids,
    type: "rapport_journalier",
    contenu: contenu || "Le rapport de présence de votre enfant est disponible.",
    mode: mode || "immediat",
    dateEnvoi: mode === "differe" ? new Date(date_envoi) : null,
  });

  res.status(201).json({ programmes: count, mode: mode || "immediat", date_envoi: date_envoi || null });
});

// GET /api/notifications/journal — historique des envois (dashboard "Notifications parents")
router.get("/journal", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT n.*, s.nom AS eleve_nom, p.nom AS parent_nom
     FROM notifications n
     JOIN students s ON s.id = n.student_id
     JOIN parents p ON p.id = n.parent_id
     ORDER BY n.created_at DESC LIMIT 50`
  );
  res.json(rows);
});

module.exports = router;
