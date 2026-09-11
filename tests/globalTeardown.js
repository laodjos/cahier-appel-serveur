const fs = require("fs");
const path = require("path");

const FICHIER_PID = path.join(__dirname, ".serveur-test.pid");

module.exports = async function () {
  if (!fs.existsSync(FICHIER_PID)) return;
  const pid = Number(fs.readFileSync(FICHIER_PID, "utf-8"));
  try {
    process.kill(pid);
  } catch (e) {
    // Déjà arrêté — rien à faire.
  }
  fs.unlinkSync(FICHIER_PID);
};
