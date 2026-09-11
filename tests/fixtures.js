const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL || "postgresql://postgres:test@localhost:5432/testdb" });

const ECOLE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const DIRECTION_ID = "aaaaaaaa-0000-0000-0000-000000000002";
const DIRECTION_EMAIL = "test-direction@cahier-appel.test";
const DIRECTION_MDP = "motdepasse123";
const CLASSE_ID = "aaaaaaaa-0000-0000-0000-000000000003";
const ELEVE_ID = "aaaaaaaa-0000-0000-0000-000000000004";
const ENSEIGNANT_ID = "aaaaaaaa-0000-0000-0000-000000000005";

// Crée (ou remet à zéro) un jeu de données isolé, préfixé "aaaaaaaa-0000...",
// pour que les tests ne dépendent jamais de ce qui existe par ailleurs dans
// la base et ne soient jamais perturbés par une exécution précédente.
async function preparerJeuDeTest() {
  const hashMdp = await bcrypt.hash(DIRECTION_MDP, 10);

  // Nettoie tout ce qui pourrait référencer l'école de test (créé par un
  // test précédent) avant de la supprimer, sinon la contrainte de clé
  // étrangère bloque la suppression.
  await pool.query("DELETE FROM paiements_scolarite WHERE eleve_id = $1", [ELEVE_ID]);
  await pool.query("DELETE FROM frais_individuels WHERE eleve_id = $1", [ELEVE_ID]);
  await pool.query("DELETE FROM frais_scolarite WHERE ecole_id = $1", [ECOLE_ID]);
  await pool.query("DELETE FROM caisses WHERE ecole_id = $1", [ECOLE_ID]);
  await pool.query("DELETE FROM attendance_events WHERE student_id = $1", [ELEVE_ID]);
  await pool.query("DELETE FROM students WHERE id = $1", [ELEVE_ID]);
  await pool.query("DELETE FROM classes WHERE id = $1", [CLASSE_ID]);
  await pool.query("DELETE FROM users WHERE id IN ($1, $2)", [DIRECTION_ID, ENSEIGNANT_ID]);
  await pool.query("DELETE FROM ecoles WHERE id = $1", [ECOLE_ID]);

  await pool.query(
    `INSERT INTO ecoles (id, nom, erp_actif) VALUES ($1, 'École de Test Automatisé', true)`,
    [ECOLE_ID]
  );
  await pool.query(
    `INSERT INTO users (id, nom, email, mot_de_passe_hash, role, ecole_id) VALUES ($1, 'Mme Test Direction', $2, $3, 'direction', $4)`,
    [DIRECTION_ID, DIRECTION_EMAIL, hashMdp, ECOLE_ID]
  );
  await pool.query(
    `INSERT INTO users (id, nom, email, mot_de_passe_hash, role, ecole_id) VALUES ($1, 'M. Test Enseignant', 'test-enseignant@cahier-appel.test', $2, 'enseignant', $3)`,
    [ENSEIGNANT_ID, hashMdp, ECOLE_ID]
  );
  await pool.query(
    `INSERT INTO classes (id, nom, niveau, ecole_id) VALUES ($1, '6ème Test', '6ème', $2)`,
    [CLASSE_ID, ECOLE_ID]
  );
  await pool.query(
    `INSERT INTO students (id, matricule, nom, prenoms, classe_id) VALUES ($1, 'TEST-001', 'Elève', 'DeTest', $2)`,
    [ELEVE_ID, CLASSE_ID]
  );
}

async function fermerPool() {
  await pool.end();
}

module.exports = {
  pool, preparerJeuDeTest, fermerPool,
  ECOLE_ID, DIRECTION_ID, DIRECTION_EMAIL, DIRECTION_MDP, CLASSE_ID, ELEVE_ID, ENSEIGNANT_ID,
};
