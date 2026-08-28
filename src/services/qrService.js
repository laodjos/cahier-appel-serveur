// Génère et vérifie le jeton signé encodé dans le QR code du badge de chaque élève.
// Le badge physique n'encode qu'un jeton opaque (pas de donnée personnelle lisible) :
// utile si un badge est perdu, on peut le révoquer en régénérant un nouveau jeton.

const jwt = require("jsonwebtoken");
const QRCode = require("qrcode");

function genererJetonEleve(studentId, matricule) {
  // Jeton sans expiration (le badge est physique et dure toute l'année scolaire),
  // mais révocable : on stocke le jeton courant en base (colonne qr_token) et on
  // n'accepte que celui qui correspond exactement à ce qui est enregistré.
  return jwt.sign({ sid: studentId, mat: matricule, typ: "badge_eleve" }, process.env.QR_SECRET);
}

function verifierJeton(token) {
  try {
    return jwt.verify(token, process.env.QR_SECRET);
  } catch {
    return null;
  }
}

// Génère l'image du QR code (data URL PNG) à partir du jeton, pour impression du badge.
async function genererImageQr(token) {
  return QRCode.toDataURL(token, { errorCorrectionLevel: "M", margin: 1, scale: 6 });
}

module.exports = { genererJetonEleve, verifierJeton, genererImageQr };
