// Crée un compte Direction par défaut si aucun compte n'existe encore.
// Usage : node src/db/creer-premier-compte.js
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool } = require("../config/db");

async function main() {
  const { rows } = await pool.query("SELECT COUNT(*) AS total FROM users");
  if (Number(rows[0].total) > 0) {
    console.log("Des comptes existent déjà — rien à faire.");
    await pool.end();
    return;
  }

  const email = process.env.PREMIER_COMPTE_EMAIL || "direction@ecole.example";
  const motDePasse = process.env.PREMIER_COMPTE_MOT_DE_PASSE || "cahier-appel-2026";
  const hash = await bcrypt.hash(motDePasse, 10);

  await pool.query(
    "INSERT INTO users (nom, email, mot_de_passe_hash, role) VALUES ($1,$2,$3,$4)",
    ["Direction", email, hash, "direction"]
  );

  console.log("✔ Compte Direction créé :");
  console.log("  Email :", email);
  console.log("  Mot de passe :", motDePasse);
  console.log("  ⚠ Change ce mot de passe dès la première connexion.");
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
