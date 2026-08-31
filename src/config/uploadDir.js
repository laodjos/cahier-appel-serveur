const fs = require("fs");
const path = require("path");

// En production, UPLOAD_DIR doit pointer vers le point de montage d'un disque
// persistant Render (ex. "/var/data/uploads") — sans ça, chaque redéploiement
// efface les photos d'élèves, le logo et le cachet de l'école. Par défaut
// (développement local, ou si la variable n'est pas configurée), on retombe
// sur l'ancien emplacement dans le dossier public — non persistant, mais
// suffisant pour tester en local.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "..", "..", "public", "uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

module.exports = { UPLOAD_DIR };
