const { appelApi, creerToken } = require("./helpers");
const { pool, preparerJeuDeTest, fermerPool, ECOLE_ID, DIRECTION_ID, CLASSE_ID, ELEVE_ID } = require("./fixtures");

let tokenDirection;

beforeAll(async () => {
  await preparerJeuDeTest();
  tokenDirection = creerToken({ sub: DIRECTION_ID, role: "direction", nom: "Mme Test Direction", ecole_id: ECOLE_ID });
});

afterAll(async () => {
  await fermerPool();
});

beforeEach(async () => {
  // Repart d'un solde propre avant chaque test de ce fichier.
  await pool.query("DELETE FROM paiements_scolarite WHERE eleve_id = $1", [ELEVE_ID]);
  await pool.query("DELETE FROM frais_scolarite WHERE ecole_id = $1", [ECOLE_ID]);
  await pool.query("DELETE FROM frais_individuels WHERE eleve_id = $1", [ELEVE_ID]);
});

describe("Solde d'un élève", () => {
  test("sans aucun frais configuré, le solde est vide (montant_total null)", async () => {
    const res = await appelApi(`/frais-scolarite/solde/${ELEVE_ID}`, { token: tokenDirection });
    expect(res.status).toBe(200);
    expect(res.data.montant_total).toBeNull();
  });

  test("un frais configuré pour le niveau s'applique bien à l'élève", async () => {
    await pool.query(
      `INSERT INTO frais_scolarite (ecole_id, niveau, libelle, montant_total, applicable_a) VALUES ($1, '6ème', 'Frais de scolarité', 250000, 'tous')`,
      [ECOLE_ID]
    );
    const res = await appelApi(`/frais-scolarite/solde/${ELEVE_ID}`, { token: tokenDirection });
    expect(res.data.montant_total).toBe(250000);
    expect(res.data.solde).toBe(250000);
    expect(res.data.a_jour).toBe(false);
  });

  // Reproduit exactement le bug corrigé : le niveau d'une classe est un champ
  // texte libre, une école peut écrire "6eme" sans accent alors que le frais
  // est configuré avec "6ème". Sans la normalisation, ce test échouerait.
  test("un frais configuré avec accent s'applique à une classe sans accent", async () => {
    await pool.query(
      `INSERT INTO frais_scolarite (ecole_id, niveau, libelle, montant_total, applicable_a) VALUES ($1, '6ème', 'Frais de scolarité', 250000, 'tous')`,
      [ECOLE_ID]
    );
    // La classe de test est déjà enregistrée avec niveau = '6ème' (avec accent)
    // dans fixtures.js — on la force ici SANS accent pour reproduire le cas réel.
    await pool.query("UPDATE classes SET niveau = '6eme' WHERE id = $1", [CLASSE_ID]);
    const res = await appelApi(`/frais-scolarite/solde/${ELEVE_ID}`, { token: tokenDirection });
    expect(res.data.montant_total).toBe(250000);
    // Remet l'accent pour ne pas perturber les autres tests de ce fichier.
    await pool.query("UPDATE classes SET niveau = '6ème' WHERE id = $1", [CLASSE_ID]);
  });

  test("un encaissement en espèces réduit bien le solde du même montant", async () => {
    await pool.query(
      `INSERT INTO frais_scolarite (ecole_id, niveau, libelle, montant_total, applicable_a) VALUES ($1, '6ème', 'Frais de scolarité', 250000, 'tous')`,
      [ECOLE_ID]
    );
    const paiement = await appelApi("/paiements-scolarite/manuel", {
      method: "POST", token: tokenDirection,
      body: { eleve_id: ELEVE_ID, montant: 100000 },
    });
    expect(paiement.status).toBe(201);

    const solde = await appelApi(`/frais-scolarite/solde/${ELEVE_ID}`, { token: tokenDirection });
    expect(solde.data.montant_paye).toBe(100000);
    expect(solde.data.solde).toBe(150000);
  });

  test("un paiement affecté à un frais précis se reflète dans le détail de CE frais uniquement", async () => {
    const fraisA = await pool.query(
      `INSERT INTO frais_scolarite (ecole_id, niveau, libelle, montant_total, applicable_a) VALUES ($1, '6ème', 'Frais de scolarité', 250000, 'tous') RETURNING id`,
      [ECOLE_ID]
    );
    await pool.query(
      `INSERT INTO frais_scolarite (ecole_id, niveau, libelle, montant_total, applicable_a) VALUES ($1, '6ème', 'Cantine', 50000, 'tous')`,
      [ECOLE_ID]
    );
    await appelApi("/paiements-scolarite/manuel", {
      method: "POST", token: tokenDirection,
      body: { eleve_id: ELEVE_ID, montant: 100000, frais_scolarite_id: fraisA.rows[0].id },
    });

    const solde = await appelApi(`/frais-scolarite/solde/${ELEVE_ID}`, { token: tokenDirection });
    const ligneScolarite = solde.data.detail.find((f) => f.libelle === "Frais de scolarité");
    const ligneCantine = solde.data.detail.find((f) => f.libelle === "Cantine");
    expect(ligneScolarite.montant_paye).toBe(100000);
    expect(ligneCantine.montant_paye).toBe(0);
  });

  test("un reliquat impayé apparaît toujours en tête du détail et déclenche l'alerte", async () => {
    await pool.query(
      `INSERT INTO frais_scolarite (ecole_id, niveau, libelle, montant_total, applicable_a) VALUES ($1, '6ème', 'Frais de scolarité', 250000, 'tous')`,
      [ECOLE_ID]
    );
    await pool.query(
      `INSERT INTO frais_individuels (eleve_id, libelle, montant, est_reliquat) VALUES ($1, 'Reliquat année précédente', 45000, true)`,
      [ELEVE_ID]
    );
    const res = await appelApi(`/frais-scolarite/solde/${ELEVE_ID}`, { token: tokenDirection });
    expect(res.data.detail[0].est_reliquat).toBe(true);
    expect(res.data.reliquat_impaye).toBe(true);
  });

  test("un élève affecté ne voit que le tarif d'inscription qui lui correspond", async () => {
    await pool.query(
      `INSERT INTO frais_scolarite (ecole_id, niveau, libelle, montant_total, applicable_a) VALUES
        ($1, '6ème', 'Inscription (affecté)', 10000, 'affecte'),
        ($1, '6ème', 'Inscription (non affecté)', 50000, 'non_affecte')`,
      [ECOLE_ID]
    );
    await pool.query("UPDATE students SET affecte = true WHERE id = $1", [ELEVE_ID]);
    const res = await appelApi(`/frais-scolarite/solde/${ELEVE_ID}`, { token: tokenDirection });
    const libelles = res.data.detail.map((f) => f.libelle);
    expect(libelles).toContain("Inscription (affecté)");
    expect(libelles).not.toContain("Inscription (non affecté)");
  });

  test("une caisse fermée refuse un encaissement", async () => {
    const caisse = await pool.query(
      `INSERT INTO caisses (ecole_id, nom, fermee) VALUES ($1, 'Caisse Test', true) RETURNING id`,
      [ECOLE_ID]
    );
    const res = await appelApi("/paiements-scolarite/manuel", {
      method: "POST", token: tokenDirection,
      body: { eleve_id: ELEVE_ID, montant: 10000, caisse_id: caisse.rows[0].id },
    });
    expect(res.status).toBe(409);
  });

  // Bug réel corrigé : supprimer un frais déjà utilisé dans un paiement
  // échouait (contrainte de clé étrangère sans règle définie). Le paiement
  // doit survivre, juste détaché du frais supprimé.
  test("un frais déjà payé peut être supprimé — le paiement survit, détaché", async () => {
    const frais = await pool.query(
      `INSERT INTO frais_scolarite (ecole_id, niveau, libelle, montant_total, applicable_a) VALUES ($1, '6ème', 'Frais à supprimer', 30000, 'tous') RETURNING id`,
      [ECOLE_ID]
    );
    const fraisId = frais.rows[0].id;
    const paiement = await appelApi("/paiements-scolarite/manuel", {
      method: "POST", token: tokenDirection,
      body: { eleve_id: ELEVE_ID, montant: 5000, frais_scolarite_id: fraisId },
    });
    expect(paiement.status).toBe(201);

    const suppression = await appelApi(`/frais-scolarite/${fraisId}`, { method: "DELETE", token: tokenDirection });
    expect(suppression.status).toBe(204);

    const verif = await pool.query("SELECT frais_scolarite_id FROM paiements_scolarite WHERE id = $1", [paiement.data.id]);
    expect(verif.rows[0].frais_scolarite_id).toBeNull();
  });

  // Revenu en arrière sur demande explicite : l'échéancier reste PAR FRAIS
  // (pas consolidé par promotion), pour que la fiche de relance précise
  // QUEL frais est en retard et de combien — l'information par frais est
  // jugée plus utile qu'un seul total générique.
  test("l'échéancier par frais donne un retard précis, propre à CE frais", async () => {
    const fraisScolarite = await pool.query(
      `INSERT INTO frais_scolarite (ecole_id, niveau, libelle, montant_total, applicable_a) VALUES
        ($1, '6ème', 'Frais de scolarité', 200000, 'tous') RETURNING id`,
      [ECOLE_ID]
    );
    const fraisCantine = await pool.query(
      `INSERT INTO frais_scolarite (ecole_id, niveau, libelle, montant_total, applicable_a) VALUES ($1, '6ème', 'Cantine', 50000, 'tous') RETURNING id`,
      [ECOLE_ID]
    );
    await pool.query(
      `INSERT INTO echeances_frais (frais_scolarite_id, libelle, montant, date_echeance) VALUES ($1, '1ère tranche', 100000, '2025-10-15')`,
      [fraisScolarite.rows[0].id]
    );
    await pool.query(
      `INSERT INTO echeances_frais (frais_scolarite_id, libelle, montant, date_echeance) VALUES ($1, 'Tranche unique', 50000, '2025-10-15')`,
      [fraisCantine.rows[0].id]
    );
    // Paye 80000 sur la scolarité (en retard de 20000), rien sur la cantine
    // (en retard de 50000) — deux frais en retard, chacun avec son montant.
    await appelApi("/paiements-scolarite/manuel", {
      method: "POST", token: tokenDirection,
      body: { eleve_id: ELEVE_ID, montant: 80000, frais_scolarite_id: fraisScolarite.rows[0].id },
    });

    const solde = await appelApi(`/frais-scolarite/solde/${ELEVE_ID}`, { token: tokenDirection });
    const ligneScolarite = solde.data.detail.find((f) => f.libelle === "Frais de scolarité");
    const ligneCantine = solde.data.detail.find((f) => f.libelle === "Cantine");
    expect(ligneScolarite.echeancier.en_retard).toBe(true);
    expect(ligneScolarite.echeancier.montant_retard).toBe(20000);
    expect(ligneCantine.echeancier.en_retard).toBe(true);
    expect(ligneCantine.echeancier.montant_retard).toBe(50000);
  });

  // Nouvelle règle : un versement sans frais précis choisi doit se répartir
  // automatiquement sur les frais restants (reliquat en premier), plutôt que
  // de rester un paiement générique non affecté à aucune ligne.
  test("un versement sans frais précis se répartit automatiquement, reliquat en premier", async () => {
    await pool.query(
      `INSERT INTO frais_scolarite (ecole_id, niveau, libelle, montant_total, applicable_a) VALUES ($1, '6ème', 'Frais de scolarité', 250000, 'tous')`,
      [ECOLE_ID]
    );
    await pool.query(
      `INSERT INTO frais_individuels (eleve_id, libelle, montant, est_reliquat) VALUES ($1, 'Reliquat', 45000, true)`,
      [ELEVE_ID]
    );

    const paiement = await appelApi("/paiements-scolarite/manuel", {
      method: "POST", token: tokenDirection,
      body: { eleve_id: ELEVE_ID, montant: 100000 },
    });
    expect(paiement.status).toBe(201);
    expect(paiement.data.repartition.length).toBe(2);
    const versReliquat = paiement.data.repartition.find((p) => p.frais_individuel_id);
    const versScolarite = paiement.data.repartition.find((p) => p.frais_scolarite_id);
    expect(Number(versReliquat.montant)).toBe(45000);
    expect(Number(versScolarite.montant)).toBe(55000);

    const solde = await appelApi(`/frais-scolarite/solde/${ELEVE_ID}`, { token: tokenDirection });
    const ligneReliquat = solde.data.detail.find((f) => f.est_reliquat);
    expect(ligneReliquat.reste).toBe(0);
    const ligneScolarite = solde.data.detail.find((f) => f.libelle === "Frais de scolarité");
    expect(ligneScolarite.montant_paye).toBe(55000);
  });

  test("l'excédent d'un versement réparti part en rendu monnaie, jamais encaissé", async () => {
    const frais = await pool.query(
      `INSERT INTO frais_scolarite (ecole_id, niveau, libelle, montant_total, applicable_a) VALUES ($1, '6ème', 'Cantine', 30000, 'tous') RETURNING id`,
      [ECOLE_ID]
    );
    const paiement = await appelApi("/paiements-scolarite/manuel", {
      method: "POST", token: tokenDirection,
      body: { eleve_id: ELEVE_ID, montant: 50000 },
    });
    expect(paiement.status).toBe(201);
    // Le rendu monnaie est signalé mais jamais inséré comme paiement.
    expect(Number(paiement.data.rendu_monnaie)).toBe(20000);
    expect(paiement.data.repartition.length).toBe(1);
    expect(Number(paiement.data.repartition[0].montant)).toBe(30000);

    const verif = await pool.query(
      "SELECT COALESCE(SUM(montant), 0) AS total FROM paiements_scolarite WHERE eleve_id = $1", [ELEVE_ID]
    );
    expect(Number(verif.rows[0].total)).toBe(30000);
  });

  test("verser sur un élève déjà entièrement à jour est refusé (rien à encaisser)", async () => {
    await pool.query(
      `INSERT INTO frais_scolarite (ecole_id, niveau, libelle, montant_total, applicable_a) VALUES ($1, '6ème', 'Cantine', 30000, 'tous')`,
      [ECOLE_ID]
    );
    await appelApi("/paiements-scolarite/manuel", {
      method: "POST", token: tokenDirection,
      body: { eleve_id: ELEVE_ID, montant: 30000 },
    });
    const second = await appelApi("/paiements-scolarite/manuel", {
      method: "POST", token: tokenDirection,
      body: { eleve_id: ELEVE_ID, montant: 10000 },
    });
    expect(second.status).toBe(400);
    expect(Number(second.data.rendu_monnaie)).toBe(10000);
  });
});
