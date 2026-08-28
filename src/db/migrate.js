// Applique le schéma SQL sur la base de données définie dans DATABASE_URL.
// Usage : npm run migrate

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  console.log("Application du schéma sur la base :", process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":****@"));
  try {
    await pool.query(sql);
    console.log("✔ Schéma appliqué avec succès.");
  } catch (err) {
    console.error("✘ Échec de la migration :", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
