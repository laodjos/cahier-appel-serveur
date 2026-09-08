const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../config/db");
const { authRequired } = require("../middleware/auth");

const router = express.Router();

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, mot_de_passe } = req.body;
  if (!email || !mot_de_passe) {
    return res.status(400).json({ error: "Email et mot de passe requis." });
  }

  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: "Identifiants invalides." });

  const ok = await bcrypt.compare(mot_de_passe, user.mot_de_passe_hash);
  if (!ok) return res.status(401).json({ error: "Identifiants invalides." });

  // Un compte rattaché à une école (donc pas le Super-administrateur) ne peut plus
  // se connecter une fois la date de fin d'utilisation de son établissement dépassée
  // — le Super-administrateur doit d'abord lui (re)assigner une nouvelle année scolaire.
  let ecoleErpActif = false;
  if (user.role !== "super_admin" && user.ecole_id) {
    const { rows: ecoleRows } = await pool.query(
      "SELECT date_fin_utilisation, suspendue, erp_actif FROM ecoles WHERE id = $1", [user.ecole_id]
    );
    if (ecoleRows[0]?.suspendue) {
      return res.status(403).json({
        error: "Accès suspendu : cet établissement a été temporairement fermé en attendant le règlement de son abonnement. Contactez l'administrateur du système.",
      });
    }
    const dateFin = ecoleRows[0]?.date_fin_utilisation;
    const aujourdHui = new Date().toISOString().slice(0, 10);
    const dateFinStr = dateFin ? new Date(dateFin).toISOString().slice(0, 10) : null;
    if (dateFinStr && dateFinStr < aujourdHui) {
      return res.status(403).json({
        error: `Accès suspendu : l'année scolaire de votre établissement s'est terminée le ${new Date(dateFin).toLocaleDateString("fr-FR")}. Contactez l'administrateur du système pour renouveler l'accès.`,
      });
    }
    ecoleErpActif = !!ecoleRows[0]?.erp_actif;
  }

  const token = jwt.sign(
    { sub: user.id, role: user.role, nom: user.nom, ecole_id: user.ecole_id },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "12h" }
  );

  res.json({ token, user: { id: user.id, nom: user.nom, role: user.role, ecole_id: user.ecole_id, matieres: user.matieres, erp_actif: ecoleErpActif } });
});

// PATCH /api/auth/mot-de-passe  { ancien_mot_de_passe, nouveau_mot_de_passe }
// Changement volontaire par la personne elle-même — contrairement à la
// réinitialisation par un administrateur, celle-ci exige de connaître l'ancien
// mot de passe, pour empêcher quelqu'un d'autre de le changer à ta place s'il
// accède un instant à ta session déjà ouverte.
router.patch("/mot-de-passe", authRequired, async (req, res) => {
  const { ancien_mot_de_passe, nouveau_mot_de_passe } = req.body;
  if (!ancien_mot_de_passe || !nouveau_mot_de_passe) {
    return res.status(400).json({ error: "Ancien et nouveau mot de passe sont requis." });
  }
  if (nouveau_mot_de_passe.length < 6) {
    return res.status(400).json({ error: "Le nouveau mot de passe doit faire au moins 6 caractères." });
  }
  const { rows } = await pool.query("SELECT mot_de_passe_hash FROM users WHERE id = $1", [req.user.sub]);
  if (!rows[0]) return res.status(404).json({ error: "Compte introuvable." });

  const ok = await bcrypt.compare(ancien_mot_de_passe, rows[0].mot_de_passe_hash);
  if (!ok) return res.status(401).json({ error: "Ancien mot de passe incorrect." });

  const hash = await bcrypt.hash(nouveau_mot_de_passe, 10);
  await pool.query("UPDATE users SET mot_de_passe_hash = $1 WHERE id = $2", [hash, req.user.sub]);
  res.status(204).send();
});

module.exports = router;
