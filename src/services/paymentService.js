const axios = require("axios");

// --------------------------------------------------------------------------
// CinetPay — https://docs.cinetpay.com (API Checkout)
// Couvre Wave, Orange Money, MTN MoMo et Moov Africa en une seule intégration,
// avec un seul contrat commerçant — contrairement à Orange Money en direct qui
// nécessite un enregistrement marchand séparé et ne couvre qu'un seul opérateur.
// --------------------------------------------------------------------------

const BASE_URL = "https://api-checkout.cinetpay.com/v2";

// Crée un lien de paiement CinetPay et renvoie l'URL vers laquelle rediriger
// l'école pour qu'elle procède au paiement (Wave, Orange Money, MTN, Moov, carte).
async function creerLienPaiement({ montant, transactionId, description, returnUrl, notifyUrl, clientNom }) {
  const apikey = process.env.CINETPAY_API_KEY;
  const siteId = process.env.CINETPAY_SITE_ID;
  if (!apikey || !siteId) throw new Error("CINETPAY_API_KEY / CINETPAY_SITE_ID ne sont pas configurés (voir .env.example).");

  const reponse = await axios.post(`${BASE_URL}/payment`, {
    apikey,
    site_id: siteId,
    transaction_id: transactionId,
    amount: montant,
    currency: "XOF",
    description: description || "Renouvellement d'abonnement Cahier d'Appel",
    customer_name: clientNom || "École",
    customer_surname: "Cliente",
    notify_url: notifyUrl,
    return_url: returnUrl,
    channels: "ALL", // laisse le client choisir Wave / Orange Money / MTN / Moov / carte
    lang: "FR",
  }, { headers: { "Content-Type": "application/json" } });

  if (reponse.data.code !== "201") {
    throw new Error(`CinetPay a refusé la demande : ${reponse.data.message || reponse.data.code}`);
  }
  return reponse.data.data; // contient { payment_url, payment_token }
}

// Vérifie le statut réel d'une transaction directement auprès de CinetPay — ne
// JAMAIS se fier uniquement au contenu brut d'une notification pour confirmer
// un paiement, toujours revérifier côté serveur avant de créditer quoi que ce soit.
async function verifierTransaction(transactionId) {
  const apikey = process.env.CINETPAY_API_KEY;
  const siteId = process.env.CINETPAY_SITE_ID;
  const reponse = await axios.post(`${BASE_URL}/payment/check`, {
    apikey,
    site_id: siteId,
    transaction_id: transactionId,
  }, { headers: { "Content-Type": "application/json" } });
  return reponse.data.data; // contient { status: "ACCEPTED" | "REFUSED" | ..., ... }
}

module.exports = { creerLienPaiement, verifierTransaction };
