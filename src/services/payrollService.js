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

// La réduction RICF suit en réalité une formule linéaire (11 000 F CFA par part
// entière au-delà de la 1ère, soit 5 500 F par demi-part) — vérifiée exacte sur
// toutes les valeurs officielles connues (1, 1.5, 2, 3, 4 et 5 parts). Utiliser
// la formule plutôt qu'une simple table permet de couvrir aussi les valeurs
// intermédiaires manquantes de la table (2.5, 3.5, 4.5 parts — ex. un salarié
// marié avec 1 ou 3 enfants), qu'une table figée aux seules valeurs ci-dessus
// aurait laissées sans réduction du tout.
function calculerRicf(partsFiscales) {
  const parts = Number(partsFiscales) || 1;
  if (parts <= 1) return 0;
  return Math.round((Math.min(parts, 5) - 1) * 11000);
}

// Détermine le nombre de parts fiscales à partir de la situation familiale
// déclarée — évite de demander à l'école de deviner elle-même la conversion.
// ⚠ Règle à faire confirmer par un comptable (voir document de méthodologie) :
//   - Célibataire / divorcé(e) sans enfant, ou veuf(ve) SANS enfant : 1 part
//   - Marié(e), ou veuf(ve) avec au moins un enfant à charge : 2 parts de base
//   - + 0,5 part par enfant à charge, quel que soit le statut
//   - Plafond légal : 5 parts maximum
function calculerPartsFiscales(statutMatrimonial, nombreEnfants) {
  const n = Math.max(0, Number(nombreEnfants) || 0);
  const base = (statutMatrimonial === "marie" || (statutMatrimonial === "veuf" && n > 0)) ? 2 : 1;
  return Math.min(5, base + n * 0.5);
}

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
  const ricf = calculerRicf(partsFiscales);
  const its_net = Math.max(0, its_brut - ricf);
  const net = Math.round(salaireBrut - cnps - its_net);
  return { cnps, its_brut, ricf, its_net, net };
}

// Regroupe des minutes travaillées jour par jour en minutes par semaine (la semaine
// commence le lundi), puis répartit chaque semaine entre heures normales (dans la
// limite du plafond réglementaire hebdomadaire) et heures supplémentaires (l'excédent).
// Plafonds officiels : 21h/semaine en 1er cycle (Collège), 18h/semaine en 2nd cycle
// (Lycée). ⚠ À faire vérifier périodiquement, ces seuils pouvant évoluer.
const SEUIL_HEBDO_MINUTES = { "1er_cycle": 21 * 60, "2nd_cycle": 18 * 60 };

function lundiDeLaSemaine(dateStr, jourSemaine) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() - (jourSemaine - 1));
  return d.toISOString().slice(0, 10);
}

// minutesParJour : [{ date: "YYYY-MM-DD", jourSemaine: 1-7, minutes: n }]
function repartirNormalesEtSupplementaires(minutesParJour, cycleEnseignement) {
  const seuil = SEUIL_HEBDO_MINUTES[cycleEnseignement];
  if (!seuil) {
    // Pas de cycle déclaré : impossible de savoir le plafond -> tout compte en heures normales.
    const total = minutesParJour.reduce((s, j) => s + j.minutes, 0);
    return { minutes_normales: total, minutes_supplementaires: 0 };
  }
  const parSemaine = {};
  for (const j of minutesParJour) {
    const cle = lundiDeLaSemaine(j.date, j.jourSemaine);
    parSemaine[cle] = (parSemaine[cle] || 0) + j.minutes;
  }
  let minutes_normales = 0, minutes_supplementaires = 0;
  for (const minutesSemaine of Object.values(parSemaine)) {
    minutes_normales += Math.min(minutesSemaine, seuil);
    minutes_supplementaires += Math.max(0, minutesSemaine - seuil);
  }
  return { minutes_normales, minutes_supplementaires };
}

module.exports = { calculerITS, calculerBulletin, calculerRicf, calculerPartsFiscales, repartirNormalesEtSupplementaires, RICF_PAR_PARTS, PLAFOND_CNPS, TAUX_CNPS_SALARIE, SEUIL_HEBDO_MINUTES };
