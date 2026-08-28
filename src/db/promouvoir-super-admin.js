// Promeut un compte existant au rôle "super_admin" (le seul à voir toutes les écoles).
// Usage : node src/db/promouvoir-super-admin.js ton-email@exemple.com
require("dotenv").config();
const { pool } = require("../config/db");

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage : node src/db/promouvoir-super-admin.js ton-email@exemple.com");
    process.exit(1);
  }
  const { rows } = await pool.query(
    "UPDATE users SET role = 'super_admin', ecole_id = NULL WHERE email = $1 RETURNING nom, email",
    [email.trim().toLowerCase()]
  );
  if (!rows[0]) {
    console.log("Aucun compte trouvé avec cet email.");
  } else {
    console.log(`✔ ${rows[0].nom} (${rows[0].email}) est maintenant Super-administrateur.`);
  }
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
