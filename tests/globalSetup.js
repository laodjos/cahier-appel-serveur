const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const FICHIER_PID = path.join(__dirname, ".serveur-test.pid");

const PORT = process.env.TEST_PORT || 4321;
const DATABASE_URL = process.env.TEST_DATABASE_URL || "postgresql://postgres:test@localhost:5432/testdb";

module.exports = async function () {
  const env = {
    ...process.env,
    DATABASE_URL,
    JWT_SECRET: "test-secret-key-for-automated-tests",
    PORT: String(PORT),
    NODE_ENV: "test",
  };

  // Applique le schéma le plus à jour sur la base de test avant de lancer
  // quoi que ce soit — comme le fait Render à chaque déploiement.
  execSync("node src/db/migrate.js", {
    cwd: path.join(__dirname, ".."),
    env,
    stdio: "inherit",
  });

  const serveur = spawn("node", ["src/server.js"], {
    cwd: path.join(__dirname, ".."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // globalSetup et globalTeardown tournent dans des processus Node séparés —
  // une variable globale ne survivrait pas entre les deux. On note donc le
  // PID du serveur dans un fichier, que globalTeardown relira pour l'arrêter.
  fs.writeFileSync(FICHIER_PID, String(serveur.pid));
  process.env.TEST_BASE_URL = `http://localhost:${PORT}/api`;

  // Attend que le serveur réponde vraiment, plutôt qu'un délai fixe qui
  // pourrait être trop court sur une machine lente et trop long sur une rapide.
  const delaiMax = Date.now() + 10000;
  while (Date.now() < delaiMax) {
    try {
      const res = await fetch(`http://localhost:${PORT}/`);
      if (res) return;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("Le serveur de test n'a pas démarré à temps.");
};
