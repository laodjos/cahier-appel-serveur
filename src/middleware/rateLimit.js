const rateLimit = require("express-rate-limit");

// Sans cette limite, un code à 6 chiffres (1 million de combinaisons) ou un
// mot de passe pourrait être deviné par un script en quelques minutes en
// essayant toutes les combinaisons. Cette limite ne bloque personne dans un
// usage normal (quelques essais suffisent toujours), seulement un script qui
// enchaînerait des centaines de tentatives.
const limiteurConnexion = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives — réessaie dans quelques minutes." },
});

const limiteurCodeOtp = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives — réessaie dans quelques minutes." },
});

module.exports = { limiteurConnexion, limiteurCodeOtp };
