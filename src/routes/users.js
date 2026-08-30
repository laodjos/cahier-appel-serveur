const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const XLSX = require("xlsx");
const { pool } = require("../config/db");
const { authRequired, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);
router.use(requireRole("direction", "super_admin"));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function ecoleEffective(req) {
  if (req.user.ecole_id) return req.user.ecole_id;
  return req.query?.ecole_id || req.body?.ecole_id || null;
}

function clauseEcole(req, params, colonne = "u.ecole_id") {
  const ecoleId = ecoleEffective(req);
  if (ecoleId) {
    params.push(ecoleId);
    return `${colonne} = $${params.length}`;
  }
  return "TRUE"; // super_admin en vue globale : voit tous les comptes, de toutes les écoles
}

// GET /api/users
router.get("/", async (req, res) => {
  const params = [];
  const filtreEcole = clauseEcole(req, params, "u.ecole_id");
  const { rows } = await pool.query(
    `SELECT u.id, u.nom, u.email, u.role, u.matieres, u.statut_emploi, u.taux_horaire, u.salaire_base, u.heures_mensuelles_reference, u.parts_fiscales, u.cycle_enseignement, u.ecole_id, u.created_at, ec.nom AS ecole_nom,
            COALESCE(
              json_agg(
                json_build_object('id', c.id, 'nom', c.nom, 'niveau', c.niveau)
              ) FILTER (WHERE c.id IS NOT NULL), '[]'
            ) AS classes_rattachees
     FROM users u
     LEFT JOIN ecoles ec ON ec.id = u.ecole_id
     LEFT JOIN enseignant_classes enc ON enc.user_id = u.id
     LEFT JOIN classes c ON c.id = enc.classe_id AND c.ecole_id IS NOT DISTINCT FROM u.ecole_id
     WHERE ${filtreEcole}
     GROUP BY u.id, ec.nom
     ORDER BY u.created_at DESC`,
    params
  );
  res.json(rows);
});

// POST /api/users  { nom, email, mot_de_passe, role, matieres, ecole_id? }
router.post("/", async (req, res) => {
  const { nom, email, mot_de_passe, role, matieres, statut_emploi } = req.body;
  const rolesValides = ["super_admin", "direction", "enseignant", "surveillant"];

  if (!nom || !email || !mot_de_passe || !role) {
    return res.status(400).json({ error: "Nom, email, mot de passe et rôle sont requis." });
  }
  if (!rolesValides.includes(role)) {
    return res.status(400).json({ error: "Rôle invalide." });
  }
  if (role === "super_admin" && req.user.role !== "super_admin") {
    return res.status(403).json({ error: "Seul un Super-administrateur peut créer un autre Super-administrateur." });
  }
  if (mot_de_passe.length < 6) {
    return res.status(400).json({ error: "Le mot de passe doit faire au moins 6 caractères." });
  }
  if (statut_emploi && !["permanent", "vacataire"].includes(statut_emploi)) {
    return res.status(400).json({ error: "Statut d'emploi invalide." });
  }

  const ecoleCible = ecoleEffective(req);
  if (role !== "super_admin" && !ecoleCible) {
    return res.status(400).json({ error: "Choisis l'école de rattachement pour ce compte." });
  }

  try {
    const hash = await bcrypt.hash(mot_de_passe, 10);
    const { rows } = await pool.query(
      "INSERT INTO users (nom, email, mot_de_passe_hash, role, matieres, ecole_id, statut_emploi) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, nom, email, role, matieres, ecole_id, statut_emploi, created_at",
      [nom.trim(), email.trim().toLowerCase(), hash, role, matieres?.trim() || null, ecoleCible, statut_emploi || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Cet email est déjà utilisé par un autre compte." });
    throw err;
  }
});

// PATCH /api/users/:id/matieres  { matieres }
// PATCH /api/users/:id/nom  { nom } — correction du nom d'un compte
router.patch("/:id/nom", async (req, res) => {
  const { nom } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: "Le nom ne peut pas être vide." });
  const params = [nom.trim(), req.params.id];
  const filtreEcole = clauseEcole(req, params, "ecole_id");
  const { rows } = await pool.query(
    `UPDATE users SET nom = $1 WHERE id = $2 AND ${filtreEcole} RETURNING id, nom, email, role, matieres, statut_emploi, ecole_id, created_at`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: "Compte introuvable (ou hors de ton école)." });
  res.json(rows[0]);
});

router.patch("/:id/matieres", async (req, res) => {
  const { matieres } = req.body;
  const params = [matieres?.trim() || null, req.params.id];
  const filtreEcole = clauseEcole(req, params, "ecole_id");
  const { rows } = await pool.query(
    `UPDATE users SET matieres = $1 WHERE id = $2 AND ${filtreEcole} RETURNING id, nom, email, role, matieres, ecole_id, created_at`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: "Compte introuvable (ou hors de ton école)." });
  res.json(rows[0]);
});

// PATCH /api/users/:id/statut-emploi  { statut_emploi } — "permanent" ou "vacataire"
// PATCH /api/users/:id/taux-horaire  { taux_horaire } — pour le calcul de la paie à l'heure
router.patch("/:id/taux-horaire", requireRole("direction", "super_admin"), async (req, res) => {
  const { taux_horaire } = req.body;
  if (taux_horaire !== null && taux_horaire !== undefined && (isNaN(taux_horaire) || Number(taux_horaire) < 0)) {
    return res.status(400).json({ error: "Le taux horaire doit être un nombre positif." });
  }
  const params = [taux_horaire === "" || taux_horaire === undefined ? null : taux_horaire, req.params.id];
  const filtreEcole = clauseEcole(req, params, "ecole_id");
  const { rows } = await pool.query(
    `UPDATE users SET taux_horaire = $1 WHERE id = $2 AND ${filtreEcole} RETURNING id, nom, email, role, matieres, statut_emploi, taux_horaire, ecole_id, created_at`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: "Compte introuvable (ou hors de ton école)." });
  res.json(rows[0]);
});

// PATCH /api/users/:id/salaire  { salaire_base, heures_mensuelles_reference, parts_fiscales }
// Pour le calcul complet de la paie (CNPS + ITS) d'un enseignant permanent.
router.patch("/:id/salaire", requireRole("direction", "super_admin"), async (req, res) => {
  const { salaire_base, heures_mensuelles_reference, parts_fiscales, cycle_enseignement } = req.body;
  const PARTS_VALIDES = [1, 1.5, 2, 3, 4, 5];
  if (parts_fiscales !== undefined && parts_fiscales !== null && !PARTS_VALIDES.includes(Number(parts_fiscales))) {
    return res.status(400).json({ error: "Parts fiscales invalides (1, 1.5, 2, 3, 4 ou 5)." });
  }
  if (cycle_enseignement && !["1er_cycle", "2nd_cycle"].includes(cycle_enseignement)) {
    return res.status(400).json({ error: "Cycle d'enseignement invalide." });
  }
  const params = [
    salaire_base === "" || salaire_base === undefined ? null : salaire_base,
    heures_mensuelles_reference === "" || heures_mensuelles_reference === undefined ? null : heures_mensuelles_reference,
    parts_fiscales === "" || parts_fiscales === undefined ? null : parts_fiscales,
    cycle_enseignement === "" || cycle_enseignement === undefined ? null : cycle_enseignement,
    req.params.id,
  ];
  const filtreEcole = clauseEcole(req, params, "ecole_id");
  const { rows } = await pool.query(
    `UPDATE users SET
       salaire_base = COALESCE($1, salaire_base),
       heures_mensuelles_reference = COALESCE($2, heures_mensuelles_reference),
       parts_fiscales = COALESCE($3, parts_fiscales),
       cycle_enseignement = COALESCE($4, cycle_enseignement)
     WHERE id = $5 AND ${filtreEcole}
     RETURNING id, nom, email, role, matieres, statut_emploi, taux_horaire, salaire_base, heures_mensuelles_reference, parts_fiscales, cycle_enseignement, ecole_id, created_at`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: "Compte introuvable (ou hors de ton école)." });
  res.json(rows[0]);
});

router.patch("/:id/statut-emploi", async (req, res) => {
  const { statut_emploi } = req.body;
  if (statut_emploi && !["permanent", "vacataire"].includes(statut_emploi)) {
    return res.status(400).json({ error: "Statut invalide (permanent ou vacataire)." });
  }
  const params = [statut_emploi || null, req.params.id];
  const filtreEcole = clauseEcole(req, params, "ecole_id");
  const { rows } = await pool.query(
    `UPDATE users SET statut_emploi = $1 WHERE id = $2 AND ${filtreEcole} RETURNING id, nom, email, role, matieres, statut_emploi, ecole_id, created_at`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: "Compte introuvable (ou hors de ton école)." });
  res.json(rows[0]);
});

// DELETE /api/users/:id
router.delete("/:id", async (req, res) => {
  if (req.params.id === req.user.sub) {
    return res.status(400).json({ error: "Impossible de supprimer ton propre compte pendant que tu es connecté avec." });
  }
  const params = [req.params.id];
  const filtreEcole = clauseEcole(req, params, "ecole_id");
  const { rowCount } = await pool.query(`DELETE FROM users WHERE id = $1 AND ${filtreEcole}`, params);
  if (rowCount === 0) return res.status(404).json({ error: "Compte introuvable (ou hors de ton école)." });
  res.status(204).send();
});

// PATCH /api/users/:id/role  { role }
router.patch("/:id/role", async (req, res) => {
  const { role } = req.body;
  const rolesValides = ["direction", "enseignant", "surveillant"]; // super_admin ne se change pas ici, par sécurité
  if (!rolesValides.includes(role)) {
    return res.status(400).json({ error: "Rôle invalide." });
  }
  const params = [role, req.params.id];
  const filtreEcole = clauseEcole(req, params, "ecole_id");
  const { rows } = await pool.query(
    `UPDATE users SET role = $1 WHERE id = $2 AND ${filtreEcole} RETURNING id, nom, email, role, ecole_id, created_at`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: "Compte introuvable (ou hors de ton école)." });
  res.json(rows[0]);
});

// PATCH /api/users/:id/ecole  { ecole_id } — rattache un compte à une école (réservé au Super-administrateur)
router.patch("/:id/ecole", requireRole("super_admin"), async (req, res) => {
  const { ecole_id } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "UPDATE users SET ecole_id = $1 WHERE id = $2 RETURNING id, nom, email, role, ecole_id, created_at",
      [ecole_id || null, req.params.id]
    );
    if (!rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Compte introuvable." }); }

    // Un enseignant qui change d'école perd automatiquement ses rattachements aux classes
    // de son ANCIENNE école — ils n'ont plus de sens et créeraient de la confusion sinon
    // (classes invisibles mais toujours listées, élèves d'une autre école qui semblent liés à lui).
    const { rowCount } = await client.query(
      `DELETE FROM enseignant_classes ec
       USING classes c
       WHERE ec.classe_id = c.id AND ec.user_id = $1 AND (c.ecole_id IS DISTINCT FROM $2)`,
      [req.params.id, ecole_id || null]
    );

    await client.query("COMMIT");
    res.json({ ...rows[0], classes_detachees: rowCount });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// POST /api/users/:id/classes  { classe_id }
// Détermine le cycle (1er/2nd) à partir du niveau d'une classe, en ignorant les
// accents/majuscules (ex. "6EME" doit être reconnu comme "6ème").
const NIVEAUX_1ER_CYCLE = ["6ème", "5ème", "4ème", "3ème"];
const NIVEAUX_2ND_CYCLE = ["2nde", "1ère", "Terminale"];
function normaliserNiveau(s) {
  return (s || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function cycleDeNiveau(niveau) {
  const n = normaliserNiveau(niveau);
  if (NIVEAUX_1ER_CYCLE.some((x) => normaliserNiveau(x) === n)) return "1er_cycle";
  if (NIVEAUX_2ND_CYCLE.some((x) => normaliserNiveau(x) === n)) return "2nd_cycle";
  return null;
}

router.post("/:id/classes", async (req, res) => {
  const { classe_id } = req.body;
  if (!classe_id) return res.status(400).json({ error: "classe_id requis." });

  // Un enseignant dont le diplôme ne permet d'enseigner qu'au 1er cycle (DEUG2)
  // ne peut jamais être rattaché à une classe de 2nd cycle (2nde, 1ère, Terminale).
  // Dans l'autre sens, un enseignant de 2nd cycle (Licence) PEUT être rattaché à
  // une classe de 1er cycle — c'est justement ce qui lui permet de compléter ses
  // 18h hebdomadaires s'il n'en trouve pas assez au 2nd cycle.
  const { rows: profRows } = await pool.query("SELECT cycle_enseignement FROM users WHERE id = $1", [req.params.id]);
  const { rows: classeRows } = await pool.query("SELECT niveau FROM classes WHERE id = $1", [classe_id]);
  if (profRows[0]?.cycle_enseignement === "1er_cycle" && classeRows[0]) {
    const cycleClasse = cycleDeNiveau(classeRows[0].niveau);
    if (cycleClasse === "2nd_cycle") {
      return res.status(403).json({ error: "Cet enseignant est déclaré 1er cycle (DEUG2) — il ne peut pas être rattaché à une classe de 2nd cycle (2nde/1ère/Terminale)." });
    }
  }

  await pool.query(
    `INSERT INTO enseignant_classes (user_id, classe_id) VALUES ($1, $2)
     ON CONFLICT (user_id, classe_id) DO NOTHING`,
    [req.params.id, classe_id]
  );
  res.status(201).json({ ok: true });
});

// DELETE /api/users/:id/classes/:classeId
router.delete("/:id/classes/:classeId", async (req, res) => {
  await pool.query(
    "DELETE FROM enseignant_classes WHERE user_id = $1 AND classe_id = $2",
    [req.params.id, req.params.classeId]
  );
  res.status(204).send();
});

// --------------------------------------------------------------------------
// GET /api/users/export — exporte les enseignants (et leurs matières/classes)
// au format Excel, pour modification hors-ligne puis réimport.
// --------------------------------------------------------------------------
router.get("/export", async (req, res) => {
  const params = [];
  const filtreEcole = clauseEcole(req, params, "u.ecole_id");
  const { rows } = await pool.query(
    `SELECT u.nom, u.email, u.role, u.matieres, u.statut_emploi,
            COALESCE(string_agg(DISTINCT c.nom, ', '), '') AS classes
     FROM users u
     LEFT JOIN enseignant_classes ec ON ec.user_id = u.id
     LEFT JOIN classes c ON c.id = ec.classe_id
     WHERE ${filtreEcole} AND u.role = 'enseignant'
     GROUP BY u.id
     ORDER BY u.nom`,
    params
  );

  const feuille = XLSX.utils.json_to_sheet(
    rows.map((r) => ({
      nom: r.nom, email: r.email, matieres: r.matieres || "", statut_emploi: r.statut_emploi || "", classes: r.classes,
    }))
  );
  const classeur = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(classeur, feuille, "Enseignants");
  const buffer = XLSX.write(classeur, { type: "buffer", bookType: "xlsx" });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=enseignants.xlsx");
  res.send(buffer);
});

// --------------------------------------------------------------------------
// POST /api/users/import — import en masse d'enseignants depuis un Excel/CSV.
// Colonnes attendues : nom, email, matieres (séparées par virgules), classes
// (noms de classes séparés par virgules, optionnel), mot_de_passe (optionnel —
// un mot de passe provisoire est généré si absent, à communiquer à l'enseignant).
// --------------------------------------------------------------------------
router.post("/import", upload.single("fichier"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu (champ \"fichier\" attendu)." });
  if (!ecoleEffective(req)) return res.status(400).json({ error: "Choisis d'abord une école pour laquelle importer des enseignants." });

  let lignes;
  try {
    const classeur = XLSX.read(req.file.buffer, { type: "buffer" });
    const feuille = classeur.Sheets[classeur.SheetNames[0]];
    lignes = XLSX.utils.sheet_to_json(feuille, { defval: "" });
  } catch {
    return res.status(400).json({ error: "Fichier illisible — vérifie que c'est bien un .xlsx ou .csv valide." });
  }
  if (lignes.length === 0) return res.status(400).json({ error: "Le fichier ne contient aucune ligne de données." });

  function normaliserCle(k) {
    return k.toString().trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  function valeur(ligne, ...cles) {
    const entree = Object.entries(ligne).find(([k]) => cles.includes(normaliserCle(k)));
    return entree ? String(entree[1]).trim() : "";
  }
  function motDePasseAleatoire() {
    return Math.random().toString(36).slice(-6) + Math.floor(Math.random() * 100);
  }

  const ecoleImport = ecoleEffective(req);
  const { rows: classesEcole } = await pool.query("SELECT id, nom FROM classes WHERE ecole_id = $1", [ecoleImport]);
  const classeParNom = new Map(classesEcole.map((c) => [c.nom.trim().toLowerCase(), c.id]));

  const crees = [];
  const erreurs = [];

  for (let i = 0; i < lignes.length; i++) {
    const ligne = lignes[i];
    const numeroLigne = i + 2;

    const nom = valeur(ligne, "nom", "enseignant", "nom complet");
    const email = valeur(ligne, "email", "e-mail", "courriel");
    const matieres = valeur(ligne, "matieres", "matière", "matières");
    const classesTexte = valeur(ligne, "classes", "classe");
    const motDePasseFourni = valeur(ligne, "mot_de_passe", "mot de passe", "password");
    const statutTexte = valeur(ligne, "statut_emploi", "statut", "vacataire").toLowerCase();
    const statutEmploi = ["permanent", "vacataire"].includes(statutTexte) ? statutTexte : null;

    if (!nom || !email) {
      erreurs.push({ ligne: numeroLigne, raison: "Nom ou email manquant." });
      continue;
    }

    const motDePasse = motDePasseFourni || motDePasseAleatoire();
    try {
      const hash = await bcrypt.hash(motDePasse, 10);
      const { rows } = await pool.query(
        "INSERT INTO users (nom, email, mot_de_passe_hash, role, matieres, ecole_id, statut_emploi) VALUES ($1,$2,$3,'enseignant',$4,$5,$6) RETURNING id",
        [nom, email.toLowerCase(), hash, matieres || null, ecoleImport, statutEmploi]
      );
      const userId = rows[0].id;

      if (classesTexte) {
        for (const nomClasse of classesTexte.split(",").map((c) => c.trim()).filter(Boolean)) {
          const classeId = classeParNom.get(nomClasse.toLowerCase());
          if (classeId) {
            await pool.query(
              "INSERT INTO enseignant_classes (user_id, classe_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
              [userId, classeId]
            );
          }
        }
      }
      crees.push({ ligne: numeroLigne, nom, email, mot_de_passe_genere: motDePasseFourni ? null : motDePasse });
    } catch (err) {
      if (err.code === "23505") erreurs.push({ ligne: numeroLigne, raison: `Email "${email}" déjà utilisé.` });
      else erreurs.push({ ligne: numeroLigne, raison: "Erreur inattendue : " + err.message });
    }
  }

  res.status(201).json({ total_lignes: lignes.length, crees: crees.length, erreurs, details_crees: crees });
});

module.exports = router;
