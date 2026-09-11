const { appelApi, creerToken } = require("./helpers");
const { preparerJeuDeTest, fermerPool, ECOLE_ID, DIRECTION_ID, CLASSE_ID, ELEVE_ID } = require("./fixtures");

let tokenDirection;

beforeAll(async () => {
  await preparerJeuDeTest();
  tokenDirection = creerToken({ sub: DIRECTION_ID, role: "direction", nom: "Mme Test Direction", ecole_id: ECOLE_ID });
});

afterAll(async () => {
  await fermerPool();
});

describe("Appel", () => {
  test("la Direction peut marquer un élève présent sans créneau", async () => {
    const res = await appelApi("/attendance/manual", {
      method: "POST",
      token: tokenDirection,
      body: { student_id: ELEVE_ID, statut: "present" },
    });
    expect(res.status).toBe(201);
    expect(res.data.statut).toBe("present");
  });

  test("le registre du jour reflète bien ce pointage", async () => {
    const aujourdHui = new Date().toISOString().slice(0, 10);
    const res = await appelApi(`/attendance/registre?classe_id=${CLASSE_ID}&date=${aujourdHui}`, {
      token: tokenDirection,
    });
    expect(res.status).toBe(200);
    const ligne = res.data.find((r) => r.student_id === ELEVE_ID);
    expect(ligne?.statut).toBe("present");
  });

  test("marquer absent plus tard écrase bien le statut précédent", async () => {
    await appelApi("/attendance/manual", {
      method: "POST",
      token: tokenDirection,
      body: { student_id: ELEVE_ID, statut: "absent" },
    });
    const aujourdHui = new Date().toISOString().slice(0, 10);
    const res = await appelApi(`/attendance/registre?classe_id=${CLASSE_ID}&date=${aujourdHui}`, {
      token: tokenDirection,
    });
    const ligne = res.data.find((r) => r.student_id === ELEVE_ID);
    expect(ligne?.statut).toBe("absent");
  });

  test("un statut invalide est refusé", async () => {
    const res = await appelApi("/attendance/manual", {
      method: "POST",
      token: tokenDirection,
      body: { student_id: ELEVE_ID, statut: "n'importe-quoi" },
    });
    expect(res.status).toBe(400);
  });
});
