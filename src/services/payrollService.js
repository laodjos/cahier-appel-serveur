// --------------------------------------------------------------------------
// Calcul CNPS + ITS — barème en vigueur depuis la réforme du 1er janvier 2024
// (ordonnance n°2023-718/719, Côte d'Ivoire). ⚠ Ces taux peuvent évoluer par
// loi de finances — à faire vérifier périodiquement par un comptable ou
// expert-comptable avant tout usage officiel.
// --------------------------------------------------------------------------

const TRANCHES_ITS = [
  { max: 75000, taux: 0 },
  { max: 240000, taux: 0.16 },
  { max: 800000, taux: 0.21 },
  { max: 2400000, taux: 0.24 },
  { max: 8000000, taux: 0.28 },
  { max: Infinity, taux: 0.32 },
];
const RICF_PAR_PARTS = { 1: 0, 1.5: 5500, 2: 11000, 3: 22000, 4: 33000, 5: 44000 };
const PLAFOND_CNPS = 3375000;
const TAUX_CNPS_SALARIE = 0.063;

function calculerITS(brut) {
  let its = 0;
  let precedent = 0;
  for (const tranche of TRANCHES_ITS) {
    if (brut <= precedent) break;
    its += (Math.min(brut, tranche.max) - precedent) * tranche.taux;
    precedent = tranche.max;
  }
  return Math.round(its);
}

// Calcule CNPS, ITS net et salaire net à partir d'un salaire brut (déjà ajusté
// des éventuelles absences) et du nombre de parts fiscales de la personne.
function calculerBulletin(salaireBrut, partsFiscales = 1) {
  const cnps = Math.round(Math.min(salaireBrut, PLAFOND_CNPS) * TAUX_CNPS_SALARIE);
  const its_brut = calculerITS(salaireBrut);
  const ricf = RICF_PAR_PARTS[partsFiscales] || 0;
  const its_net = Math.max(0, its_brut - ricf);
  const net = Math.round(salaireBrut - cnps - its_net);
  return { cnps, its_brut, ricf, its_net, net };
}

module.exports = { calculerITS, calculerBulletin, RICF_PAR_PARTS, PLAFOND_CNPS, TAUX_CNPS_SALARIE };
