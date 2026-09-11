# Tests automatisés

## Lancer les tests

```bash
export TEST_DATABASE_URL="postgresql://postgres:MOT_DE_PASSE@localhost:5432/testdb"
npm test
```

`TEST_DATABASE_URL` doit pointer vers une base **de test**, jamais la base de
production — les tests suppriment et recréent des données librement dans les
lignes qu'ils utilisent (préfixées `aaaaaaaa-0000-...`, voir `fixtures.js`).

Si `TEST_DATABASE_URL` n'est pas définie, les tests utilisent par défaut
`postgresql://postgres:test@localhost:5432/testdb`.

## Ce que ça fait automatiquement

1. Applique le schéma le plus à jour (`npm run migrate`) sur la base de test.
2. Démarre un vrai serveur (`node src/server.js`) sur le port 4321.
3. Lance tous les fichiers `tests/*.test.js` contre ce serveur, un par un.
4. Arrête le serveur à la fin, que les tests aient réussi ou non.

## Ce qui est couvert aujourd'hui

- **connexion.test.js** — identifiants valides/invalides, accès refusé sans jeton.
- **appel.test.js** — pointage manuel, lecture du registre, statut invalide refusé.
- **solde-et-encaissement.test.js** — le plus important : calcul du solde,
  frais par niveau, **tolérance aux accents dans le niveau d'une classe**
  (bug réel corrigé — ce test aurait échoué avant la correction), affectation
  d'un paiement à un frais précis, priorité du reliquat, filtre affecté/non
  affecté, blocage d'encaissement sur une caisse fermée.

## Ajouter un nouveau test

Un nouveau fichier `tests/mon-scenario.test.js` :

```js
const { appelApi, creerToken } = require("./helpers");
const { preparerJeuDeTest, fermerPool, ECOLE_ID, DIRECTION_ID } = require("./fixtures");

let tokenDirection;

beforeAll(async () => {
  await preparerJeuDeTest(); // jeu de données propre et connu
  tokenDirection = creerToken({ sub: DIRECTION_ID, role: "direction", nom: "Mme Test Direction", ecole_id: ECOLE_ID });
});

afterAll(async () => {
  await fermerPool();
});

test("mon scénario", async () => {
  const res = await appelApi("/un-endpoint", { token: tokenDirection });
  expect(res.status).toBe(200);
});
```

**Priorité pour la suite** : bulletins/moyennes (calcul des coefficients),
paie (calcul des parts fiscales), et tout nouveau bug corrigé — écrire un
test qui reproduit le bug AVANT de le corriger est le meilleur moyen d'être
sûr qu'il ne revient jamais.
