const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { pool } = require("../config/db");

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
  if (user.role !== "super_admin" && user.ecole_id) {
    const { rows: ecoleRows } = await pool.query(
      "SELECT date_fin_utilisation FROM ecoles WHERE id = $1", [user.ecole_id]
    );
    const dateFin = ecoleRows[0]?.date_fin_utilisation;
    const aujourdHui = new Date().toISOString().slice(0, 10);
    const dateFinStr = dateFin ? new Date(dateFin).toISOString().slice(0, 10) : null;
    if (dateFinStr && dateFinStr < aujourdHui) {
      return res.status(403).json({
        error: `Accès suspendu : l'année scolaire de votre établissement s'est terminée le ${new Date(dateFin).toLocaleDateString("fr-FR")}. Contactez l'administrateur du système pour renouveler l'accès.`,
      });
    }
  }

  const token = jwt.sign(
    { sub: user.id, role: user.role, nom: user.nom, ecole_id: user.ecole_id },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "12h" }
  );

  res.json({ token, user: { id: user.id, nom: user.nom, role: user.role, ecole_id: user.ecole_id } });
});

module.exports = router;
