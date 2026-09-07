// Compile public/app.jsx (source lisible, celle à modifier pour toute nouvelle
// fonctionnalité) en public/app.min.js (version minifiée, réellement servie aux
// visiteurs) — évite d'exposer le code source en clair dans le navigateur.
//
// Usage : node scripts/build.js
// À relancer à chaque modification de public/app.jsx avant de déployer.

const fs = require("fs");
const path = require("path");
const babel = require("@babel/core");
const { minify } = require("terser");

async function build() {
  const cheminSource = path.join(__dirname, "..", "public", "app.jsx");
  const cheminSortie = path.join(__dirname, "..", "public", "app.min.js");

  const source = fs.readFileSync(cheminSource, "utf-8");

  console.log("Transformation JSX → JavaScript (Babel)...");
  const { code: codeTransforme } = await babel.transformAsync(source, {
    presets: [["@babel/preset-react", { runtime: "classic", development: false }]],
    filename: "app.jsx",
  });

  console.log("Minification (Terser)...");
  const resultat = await minify(codeTransforme, {
    compress: true,
    mangle: true,
  });

  if (resultat.error) throw resultat.error;

  fs.writeFileSync(cheminSortie, resultat.code);
  const tailleAvant = (source.length / 1024).toFixed(0);
  const tailleApres = (resultat.code.length / 1024).toFixed(0);
  console.log(`✔ Compilé : ${tailleAvant} Ko (source) → ${tailleApres} Ko (minifié)`);
}

build().catch((err) => {
  console.error("Échec de la compilation :", err);
  process.exit(1);
});
