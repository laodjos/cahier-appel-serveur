// À lancer UNE FOIS après la mise à jour, si tu avais déjà des classes/lecteurs
// créés avant l'ajout de la gestion multi-écoles. Range tout ce qui n'est
// rattaché à aucune école dans une "École par défaut" nouvellement créée
// (ou déjà existante si tu relances ce script par erreur — sans danger).
// Usage : node src/db/migrer-vers-multi-ecoles.js

require("dotenv").config();
const { pool } = require("../config/db");

async function main() {
  const { rows: sansEcole } = await pool.query(
    "SELECT COUNT(*) AS total FROM classes WHERE ecole_id IS NULL"
  );
  if (Number(sansEcole[0].total) === 0) {
    console.log("Aucune classe sans école — rien à faire.");
    await pool.end();
    return;
  }

  let { rows: existante } = await pool.query(
    "SELECT * FROM ecoles WHERE nom = 'École par défaut'"
  );
  let ecole = existante[0];
  if (!ecole) {
    const { rows } = await pool.query(
      "INSERT INTO ecoles (nom, active) VALUES ('École par défaut', true) RETURNING *"
    );
    ecole = rows[0];
    console.log("✔ École par défaut créée.");
  }

  const { rowCount: classesMaj } = await pool.query(
    "UPDATE classes SET ecole_id = $1 WHERE ecole_id IS NULL", [ecole.id]
  );
  const { rowCount: devicesMaj } = await pool.query(
    "UPDATE devices SET ecole_id = $1 WHERE ecole_id IS NULL", [ecole.id]
  );

  console.log(`✔ ${classesMaj} classe(s) et ${devicesMaj} lecteur(s) rattachés à "École par défaut".`);
  console.log("Les comptes utilisateurs existants restent en accès \"toutes écoles\" (ecole_id vide) — tu peux les rattacher à une école précise depuis Paramètres si besoin.");
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
