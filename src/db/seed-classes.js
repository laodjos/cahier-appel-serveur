// Crée un jeu de classes par défaut, du collège au lycée, chacune rattachée
// à son niveau (utilisé pour le regroupement dans l'interface).
// Sans danger à rejouer : ON CONFLICT (nom) DO NOTHING ignore les classes déjà créées.
// Usage : node src/db/seed-classes.js

require("dotenv").config();
const { pool } = require("../config/db");

const NIVEAUX = ["6ème", "5ème", "4ème", "3ème", "2nde", "1ère", "Terminale"];

async function main() {
  let creees = 0;
  for (const niveau of NIVEAUX) {
    const nomClasse = `${niveau} A`;
    const { rowCount } = await pool.query(
      `INSERT INTO classes (nom, niveau) VALUES ($1, $2)
       ON CONFLICT (nom) DO NOTHING`,
      [nomClasse, niveau]
    );
    if (rowCount > 0) {
      console.log(`✔ Classe créée : ${nomClasse} (niveau ${niveau})`);
      creees++;
    } else {
      console.log(`— Déjà existante, ignorée : ${nomClasse}`);
    }
  }
  console.log(`\n${creees} nouvelle(s) classe(s) créée(s) sur ${NIVEAUX.length} niveaux.`);
  console.log("Tu peux ajouter d'autres classes (6ème B, 6ème C, ...) directement depuis l'interface.");
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
