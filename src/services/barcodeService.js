const bwipjs = require("bwip-js");

// Génère l'image d'un code-barres Code128 (data URL PNG) à partir d'un texte
// quelconque (ex. le matricule d'un élève) — lisible par la plupart des
// douchettes de caisse standard, sans configuration particulière côté lecteur.
async function genererImageCodeBarres(texte) {
  const buffer = await bwipjs.toBuffer({
    bcid: "code128",
    text: texte,
    scale: 3,
    height: 12,
    includetext: true,
    textxalign: "center",
  });
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

module.exports = { genererImageCodeBarres };
