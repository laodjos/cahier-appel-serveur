module.exports = {
  testEnvironment: "node",
  globalSetup: "<rootDir>/tests/globalSetup.js",
  globalTeardown: "<rootDir>/tests/globalTeardown.js",
  testTimeout: 15000,
  // Les tests touchent tous la MÊME base de test et le MÊME serveur — les
  // lancer en parallèle créerait des interférences (un test qui encaisse
  // pendant qu'un autre calcule un solde, par exemple). On les exécute donc
  // les uns après les autres, un seul fichier à la fois.
  maxWorkers: 1,
};
