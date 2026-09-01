const express = require("express");
const { pool } = require("../config/db");
const { authRequired } = require("../middleware/auth");

const router = express.Router();

// GET /api/push/vapid-public-key — accessible sans authentification, c'est une
// clé PUBLIQUE conçue pour être distribuée (elle ne permet pas d'envoyer de
// notifications, seulement de s'y abonner).
router.get("/vapid-public-key", (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) return res.status(503).json({ error: "Notifications push non configurées côté serveur." });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

router.use(authRequired);

// POST /api/push/subscribe  { endpoint, keys: { p256dh, auth } }
router.post("/subscribe", async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: "Abonnement push invalide (endpoint et keys requis)." });
  }
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4`,
    [req.user.sub, endpoint, keys.p256dh, keys.auth]
  );
  res.status(201).json({ ok: true });
});

// POST /api/push/unsubscribe  { endpoint }
router.post("/unsubscribe", async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
  res.status(204).send();
});

module.exports = router;
