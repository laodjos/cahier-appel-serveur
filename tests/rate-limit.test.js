const { appelApi } = require("./helpers");
const { preparerJeuDeTest, fermerPool, DIRECTION_EMAIL } = require("./fixtures");

// Ce fichier épuise volontairement le quota de tentatives sur /auth/login et
// /parent-auth/verifier-code — un compteur partagé par tout le serveur de
// test, pas propre à ce fichier. L'ordre alphabétique (voir tests/sequenceur.js)
// garantit qu'il s'exécute APRÈS connexion.test.js, pour ne pas lui faire
// perdre ses propres tentatives légitimes.

beforeAll(async () => {
  await preparerJeuDeTest();
});

afterAll(async () => {
  await fermerPool();
});

describe("Limitation de débit (protection contre la force brute)", () => {
  test("après 10 tentatives de connexion ratées, la 11e est bloquée (429)", async () => {
    for (let i = 0; i < 10; i++) {
      await appelApi("/auth/login", {
        method: "POST",
        body: { email: DIRECTION_EMAIL, mot_de_passe: "mauvais-mot-de-passe" },
      });
    }
    const derniere = await appelApi("/auth/login", {
      method: "POST",
      body: { email: DIRECTION_EMAIL, mot_de_passe: "mauvais-mot-de-passe" },
    });
    expect(derniere.status).toBe(429);
  });

  test("après 10 tentatives de code OTP ratées, la 11e est bloquée (429)", async () => {
    for (let i = 0; i < 10; i++) {
      await appelApi("/parent-auth/verifier-code", {
        method: "POST",
        body: { telephone: "0700000099", code: "000000" },
      });
    }
    const derniere = await appelApi("/parent-auth/verifier-code", {
      method: "POST",
      body: { telephone: "0700000099", code: "000000" },
    });
    expect(derniere.status).toBe(429);
  });
});
