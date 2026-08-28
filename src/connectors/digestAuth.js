// Implémentation minimale de l'authentification HTTP Digest (RFC 7616),
// nécessaire car les terminaux Hikvision n'acceptent que ce mode d'authentification sur ISAPI.
// axios ne le gère pas nativement : on fait un premier appel pour récupérer le challenge,
// puis on rejoue la requête avec l'en-tête Authorization calculé.

const axios = require("axios");
const crypto = require("crypto");

class DigestAuth {
  constructor(utilisateur, motDePasse) {
    this.utilisateur = utilisateur;
    this.motDePasse = motDePasse;
  }

  async request(config) {
    try {
      return await axios({ ...config, timeout: 8000 });
    } catch (err) {
      const wwwAuth = err.response?.headers?.["www-authenticate"];
      if (err.response?.status !== 401 || !wwwAuth) throw err;

      const header = this._construireEnteteDigest(config.method, config.url, wwwAuth);
      return axios({ ...config, timeout: 8000, headers: { ...config.headers, Authorization: header } });
    }
  }

  _construireEnteteDigest(method, url, wwwAuth) {
    const params = Object.fromEntries(
      [...wwwAuth.matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1], m[2]])
    );
    const { realm, nonce, qop } = params;
    const uri = new URL(url).pathname + new URL(url).search;
    const nc = "00000001";
    const cnonce = crypto.randomBytes(8).toString("hex");

    const ha1 = crypto.createHash("md5").update(`${this.utilisateur}:${realm}:${this.motDePasse}`).digest("hex");
    const ha2 = crypto.createHash("md5").update(`${method}:${uri}`).digest("hex");
    const response = crypto
      .createHash("md5")
      .update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
      .digest("hex");

    return (
      `Digest username="${this.utilisateur}", realm="${realm}", nonce="${nonce}", uri="${uri}", ` +
      `qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`
    );
  }
}

module.exports = { DigestAuth };
