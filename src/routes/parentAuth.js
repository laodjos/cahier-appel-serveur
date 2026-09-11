const express = require("express");
const jwt = require("jsonwebtoken");
const { pool } = require("../config/db");
const { envoyerViaOrangeSms, normaliserNumeroCi } = require("../services/notificationService");
const { authRequired, requireRole } = require("../middleware/auth");
const { limiteurCodeOtp } = require("../middleware/rateLimit");

const router = express.Router();

function genererCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// POST /api/parent-auth/demander-code  { telephone }
// Envoie un code à usage unique par SMS — pas de mot de passe à retenir, comme
// une connexion WhatsApp. Limité à un envoi par minute par numéro, pour éviter
// les abus (coût des SMS).
router.post("/demander-code", limiteurCodeOtp, async (req, res) => {
  const { telephone } = req.body;
  if (!telephone) return res.status(400).json({ error: "Numéro de téléphone requis." });
  const telephoneNorm = normaliserNumeroCi(telephone);

  // Les numéros stockés dans "parents" peuvent avoir été saisis sous des formats
  // variés ("07 00 00 00 00", "+225...", etc.) — on normalise des deux côtés
  // avant de comparer, plutôt qu'une correspondance texte exacte trop fragile.
  const { rows: tousLesParents } = await pool.query("SELECT id, telephone FROM parents");
  const parentTrouve = tousLesParents.find((p) => normaliserNumeroCi(p.telephone) === telephoneNorm);
  if (!parentTrouve) {
    return res.status(404).json({ error: "Ce numéro n'est rattaché à aucun élève. Contacte l'établissement pour qu'il t'enregistre." });
  }

  const { rows: recent } = await pool.query(
    "SELECT created_at FROM parent_otp WHERE telephone = $1 ORDER BY created_at DESC LIMIT 1", [telephoneNorm]
  );
  if (recent[0] && Date.now() - new Date(recent[0].created_at).getTime() < 60000) {
    return res.status(429).json({ error: "Un code a déjà été envoyé il y a moins d'une minute — patiente un peu avant d'en redemander un." });
  }

  const code = genererCode();
  const expireA = new Date(Date.now() + 10 * 60000);
  await pool.query(
    "INSERT INTO parent_otp (telephone, code, expire_a) VALUES ($1, $2, $3)",
    [telephoneNorm, code, expireA]
  );

  try {
    await envoyerViaOrangeSms(telephone, `Ton code de connexion Cahier d'Appel : ${code} (valable 10 minutes).`);
  } catch (err) {
    console.error("Échec d'envoi du code SMS parent :", err.message);
    return res.status(502).json({ error: "Impossible d'envoyer le SMS pour le moment. Réessaie dans un instant." });
  }
  res.status(201).json({ ok: true });
});

// POST /api/parent-auth/generer-code-assiste  { telephone }
// Pour le personnel (Direction/Surveillant) : génère un code SANS passer par
// le SMS automatique (peu fiable tant que le nom d'expéditeur Orange n'est
// pas validé) — à envoyer soi-même au parent via WhatsApp, en un clic, depuis
// son propre téléphone. Ne remplace pas une vraie intégration WhatsApp
// Business (qui demande un compte API dédié), mais fonctionne dès maintenant.
router.post("/generer-code-assiste", authRequired, requireRole("direction", "surveillant", "super_admin"), async (req, res) => {
  const { telephone } = req.body;
  if (!telephone) return res.status(400).json({ error: "Numéro de téléphone requis." });
  const telephoneNorm = normaliserNumeroCi(telephone);

  const code = genererCode();
  const expireA = new Date(Date.now() + 10 * 60000);
  await pool.query(
    "INSERT INTO parent_otp (telephone, code, expire_a) VALUES ($1, $2, $3)",
    [telephoneNorm, code, expireA]
  );

  const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
  // "via=whatsapp" indique à la page de sauter l'étape "Recevoir un code par
  // SMS" — le parent a déjà son code, pas besoin d'en redemander un autre.
  const lienPortail = `${baseUrl}/espace-parent.html?tel=${encodeURIComponent(telephoneNorm)}&via=whatsapp`;
  const message = `Bonjour, voici ton code de connexion à l'Espace Parent Cahier d'Appel : ${code} (valable 10 minutes).\n\nOuvre ce lien, ton numéro et le code seront déjà prêts : ${lienPortail}`;
  // wa.me attend le numéro complet sans "+" ni espaces.
  const lienWhatsapp = `https://wa.me/${telephoneNorm}?text=${encodeURIComponent(message)}`;
  res.status(201).json({ code, message, lien_portail: lienPortail, lien_whatsapp: lienWhatsapp });
});

// POST /api/parent-auth/verifier-code  { telephone, code }
router.post("/verifier-code", limiteurCodeOtp, async (req, res) => {
  const { telephone, code } = req.body;
  if (!telephone || !code) return res.status(400).json({ error: "Numéro et code requis." });
  const telephoneNorm = normaliserNumeroCi(telephone);

  const { rows } = await pool.query(
    `SELECT * FROM parent_otp WHERE telephone = $1 AND code = $2 AND utilise = false AND expire_a > now()
     ORDER BY created_at DESC LIMIT 1`,
    [telephoneNorm, code]
  );
  if (!rows[0]) return res.status(401).json({ error: "Code invalide ou expiré." });

  await pool.query("UPDATE parent_otp SET utilise = true WHERE id = $1", [rows[0].id]);

  const token = jwt.sign({ telephone, typ: "parent" }, process.env.JWT_SECRET, { expiresIn: "60d" });
  res.json({ token });
});

module.exports = router;
