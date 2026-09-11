const { appelApi } = require("./helpers");
const { preparerJeuDeTest, fermerPool, DIRECTION_EMAIL, DIRECTION_MDP } = require("./fixtures");

beforeAll(async () => {
  await preparerJeuDeTest();
});

afterAll(async () => {
  await fermerPool();
});

describe("Connexion", () => {
  test("un compte avec le bon email et mot de passe se connecte et reçoit un jeton", async () => {
    const res = await appelApi("/auth/login", {
      method: "POST",
      body: { email: DIRECTION_EMAIL, mot_de_passe: DIRECTION_MDP },
    });
    expect(res.status).toBe(200);
    expect(res.data.token).toBeTruthy();
    expect(res.data.user.role).toBe("direction");
  });

  test("un mauvais mot de passe est refusé", async () => {
    const res = await appelApi("/auth/login", {
      method: "POST",
      body: { email: DIRECTION_EMAIL, mot_de_passe: "mauvais-mot-de-passe" },
    });
    expect(res.status).toBe(401);
  });

  test("un email inconnu est refusé", async () => {
    const res = await appelApi("/auth/login", {
      method: "POST",
      body: { email: "personne@inconnu.test", mot_de_passe: "peu-importe" },
    });
    expect(res.status).toBe(401);
  });

  test("une route protégée refuse l'accès sans jeton", async () => {
    const res = await appelApi("/students");
    expect(res.status).toBe(401);
  });
});
