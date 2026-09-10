const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");
const { pool } = require("../config/db");
const { authRequired, requireRole } = require("../middleware/auth");
const { genererJetonEleve, genererImageQr } = require("../services/qrService");
const { genererImageCodeBarres } = require("../services/barcodeService");
const { UPLOAD_DIR } = require("../config/uploadDir");

const router = express.Router();
router.use(authRequired);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Dossier où sont stockées les photos d'élèves — voir src/config/uploadDir.js
// pour le choix de l'emplacement (disque persistant en production).
const DOSSIER_PHOTOS = path.join(UPLOAD_DIR, "students");
fs.mkdirSync(DOSSIER_PHOTOS, { recursive: true });

function ecoleEffective(req) {
  if (req.user.ecole_id) return req.user.ecole_id;
  return req.query?.ecole_id || req.body?.ecole_id || null;
}

// GET /api/students?classe_id=...&search=...
router.get("/", async (req, res) => {
  const { classe_id, search } = req.query;
  const conditions = [];
  const params = [];

  if (classe_id) { params.push(classe_id); conditions.push(`s.classe_id = $${params.length}`); }
  if (search) { params.push(`%${search}%`); conditions.push(`s.nom ILIKE $${params.length}`); }
  if (ecoleEffective(req)) { params.push(ecoleEffective(req)); conditions.push(`c.ecole_id = $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT s.*, c.nom AS classe_nom, c.niveau AS classe_niveau,
            p.nom AS parent_nom, p.telephone AS parent_telephone
     FROM students s
     LEFT JOIN classes c ON c.id = s.classe_id
     LEFT JOIN LATERAL (
       SELECT pa.nom, pa.telephone FROM student_parents sp
       JOIN parents pa ON pa.id = sp.parent_id
       WHERE sp.student_id = s.id
       ORDER BY sp.parent_id LIMIT 1
     ) p ON TRUE
     ${where}
     ORDER BY s.nom`,
    params
  );
  res.json(rows);
});

// GET /api/students/export — Excel de la liste complète des élèves (avec parent rattaché)
// Placée ICI, avant toute route "/:id..." — sinon Express confondrait "export" avec un identifiant.
router.get("/export", async (req, res) => {
  const params = [];
  let filtreEcole = "TRUE";
  const ecoleId = ecoleEffective(req);
  if (ecoleId) { params.push(ecoleId); filtreEcole = "c.ecole_id = $1"; }
  const { rows } = await pool.query(
    `SELECT s.matricule, s.nom, c.nom AS classe, c.niveau, s.date_naissance, s.lieu_naissance,
            p.nom AS parent_nom, p.telephone AS parent_telephone
     FROM students s
     LEFT JOIN classes c ON c.id = s.classe_id
     LEFT JOIN LATERAL (
       SELECT pa.nom, pa.telephone FROM student_parents sp
       JOIN parents pa ON pa.id = sp.parent_id
       WHERE sp.student_id = s.id ORDER BY sp.parent_id LIMIT 1
     ) p ON TRUE
     WHERE ${filtreEcole}
     ORDER BY c.niveau NULLS LAST, c.nom NULLS LAST, s.nom`,
    params
  );

  const feuille = XLSX.utils.json_to_sheet(
    rows.map((r) => ({
      matricule: r.matricule, nom: r.nom, classe: r.classe || "", niveau: r.niveau || "",
      date_naissance: r.date_naissance ? r.date_naissance.toISOString().slice(0, 10) : "",
      lieu_naissance: r.lieu_naissance || "", parent_nom: r.parent_nom || "", parent_telephone: r.parent_telephone || "",
    }))
  );
  const classeur = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(classeur, feuille, "Élèves");
  const buffer = XLSX.write(classeur, { type: "buffer", bookType: "xlsx" });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=eleves.xlsx");
  res.send(buffer);
});

// --------------------------------------------------------------------------
// GET /api/students/export-desps — export au format du "Fichier National des
// Élèves" (DESPS, mena-desps.org) : mêmes champs que la "Fiche de demande
// d'immatriculation" officielle, pour réduire la ressaisie manuelle sur le
// portail. ⚠ Il n'existe pas d'API publique DESPS/DOB pour l'envoi
// automatique — ce fichier reste à déposer/saisir manuellement sur le portail.
// Colonnes en trop dans le système (genre, nationalité, parents séparés...)
// sont laissées vides, à compléter avant dépôt.
// --------------------------------------------------------------------------
router.get("/export-desps", async (req, res) => {
  const params = [];
  let filtreEcole = "TRUE";
  const ecoleId = ecoleEffective(req);
  if (ecoleId) { params.push(ecoleId); filtreEcole = "c.ecole_id = $1"; }
  const { rows } = await pool.query(
    `SELECT s.matricule, s.nom, s.prenoms, s.genre, s.nationalite, s.nom_pere, s.nom_mere,
            c.nom AS classe, c.niveau, s.date_naissance, s.lieu_naissance,
            p.nom AS parent_nom, p.telephone AS parent_telephone, ec.nom AS ecole_nom
     FROM students s
     LEFT JOIN classes c ON c.id = s.classe_id
     LEFT JOIN ecoles ec ON ec.id = c.ecole_id
     LEFT JOIN LATERAL (
       SELECT pa.nom, pa.telephone FROM student_parents sp
       JOIN parents pa ON pa.id = sp.parent_id
       WHERE sp.student_id = s.id ORDER BY sp.parent_id LIMIT 1
     ) p ON TRUE
     WHERE ${filtreEcole}
     ORDER BY c.niveau NULLS LAST, c.nom NULLS LAST, s.nom`,
    params
  );

  const donneesExport = rows.map((r) => ({
    "Établissement": r.ecole_nom || "",
    "Niveau": r.niveau || "",
    "Classe": r.classe || "",
    "Matricule national (si déjà attribué)": r.matricule || "",
    "Nom": r.nom || "",
    "Prénoms": r.prenoms || "",
    "Date de naissance (JJ/MM/AAAA)": r.date_naissance ? r.date_naissance.toISOString().slice(0, 10).split("-").reverse().join("/") : "",
    "Lieu de naissance — Localité/Commune": r.lieu_naissance || "",
    "Lieu de naissance — Sous-préfecture ou Ville (à compléter)": "",
    "Pays de naissance (à compléter)": "",
    "Genre": r.genre || "",
    "Nationalité": r.nationalite || "",
    "Nom et prénoms du Père": r.nom_pere || "",
    "Nom et prénoms de la Mère": r.nom_mere || (r.parent_nom || ""),
    "Contact parent/tuteur": r.parent_telephone || "",
  }));
  const feuille = XLSX.utils.json_to_sheet(donneesExport);
  feuille["!cols"] = Object.keys(donneesExport[0] || {}).map(() => ({ wch: 26 }));
  const classeur = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(classeur, feuille, "Fichier National Élèves");
  const buffer = XLSX.write(classeur, { type: "buffer", bookType: "xlsx" });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=export-desps-fichier-national-eleves.xlsx");
  res.send(buffer);
});

// POST /api/students  { matricule, nom, classe_id, methode_biometrique }
router.post("/", requireRole("direction", "surveillant"), async (req, res) => {
  const { matricule, nom, classe_id, methode_biometrique, parent_nom, parent_telephone, date_naissance, lieu_naissance, prenoms, genre, nationalite, nom_pere, nom_mere, affecte } = req.body;
  if (!matricule || !nom) return res.status(400).json({ error: "Matricule et nom requis." });
  if (!parent_telephone || !parent_telephone.trim()) {
    return res.status(400).json({ error: "Le téléphone du parent/tuteur est requis dès l'inscription de l'élève." });
  }
  if (genre && !["M", "F"].includes(genre)) return res.status(400).json({ error: "Genre invalide (M ou F)." });

  // Vérifie que la classe choisie appartient bien à l'école de l'utilisateur
  // (empêche d'inscrire un élève dans la classe d'une AUTRE école par erreur).
  if (classe_id && req.user.ecole_id) {
    const { rows } = await pool.query("SELECT ecole_id FROM classes WHERE id = $1", [classe_id]);
    if (!rows[0] || rows[0].ecole_id !== req.user.ecole_id) {
      return res.status(403).json({ error: "Cette classe n'appartient pas à ton école." });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO students (matricule, nom, classe_id, methode_biometrique, date_naissance, lieu_naissance, prenoms, genre, nationalite, nom_pere, nom_mere, affecte)
       VALUES ($1, $2, $3, COALESCE($4, 'aucune'), $5, $6, $7, $8, COALESCE($9, 'Ivoirienne'), $10, $11, $12) RETURNING *`,
      [matricule, nom, classe_id || null, methode_biometrique, date_naissance || null, lieu_naissance || null, prenoms || null, genre || null, nationalite || null, nom_pere || null, nom_mere || null, affecte !== undefined ? !!affecte : null]
    );
    const student = rows[0];

    // Génère et enregistre le jeton du badge QR de l'élève — automatique, dès l'inscription
    const token = genererJetonEleve(student.id, student.matricule);
    await client.query("UPDATE students SET qr_token = $1 WHERE id = $2", [token, student.id]);

    // Rattachement parent obligatoire, fait dans la foulée de l'inscription
    let { rows: parentRows } = await client.query("SELECT * FROM parents WHERE telephone = $1", [parent_telephone.trim()]);
    let parent = parentRows[0];
    if (!parent) {
      const insert = await client.query(
        "INSERT INTO parents (nom, telephone) VALUES ($1, $2) RETURNING *",
        [parent_nom?.trim() || "Parent", parent_telephone.trim()]
      );
      parent = insert.rows[0];
    }
    await client.query(
      "INSERT INTO student_parents (student_id, parent_id, lien) VALUES ($1, $2, 'parent')",
      [student.id, parent.id]
    );

    await client.query("COMMIT");
    res.status(201).json({ ...student, qr_token: token, parent });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: "⚠ Ce matricule est déjà utilisé par un autre élève — l'élève N'A PAS été créé. Change le matricule et réessaie." });
    throw err;
  } finally {
    client.release();
  }
});

// GET /api/students/:id/badge  -> image PNG (data URL) du QR code à imprimer
router.get("/:id/badge", async (req, res) => {
  const { rows } = await pool.query("SELECT qr_token FROM students WHERE id = $1", [req.params.id]);
  if (!rows[0]?.qr_token) return res.status(404).json({ error: "Élève ou badge introuvable." });
  const image = await genererImageQr(rows[0].qr_token);
  res.json({ image });
});

// GET /api/students/:id/barcode -> image PNG (data URL) du code-barres du
// matricule, pour lecture rapide à la caisse avec une douchette standard.
router.get("/:id/barcode", async (req, res) => {
  const { genererImageCodeBarres } = require("../services/barcodeService");
  const { rows } = await pool.query("SELECT matricule FROM students WHERE id = $1", [req.params.id]);
  if (!rows[0]?.matricule) return res.status(404).json({ error: "Élève introuvable." });
  const image = await genererImageCodeBarres(rows[0].matricule);
  res.json({ image });
});

// POST /api/students/:id/parents  { nom, telephone, email }
// Rattache (ou crée) un parent à un élève — alimente la section "Rattachement parents".
router.post("/:id/parents", requireRole("direction", "surveillant"), async (req, res) => {
  const { nom, telephone, email, lien } = req.body;
  if (!telephone || !telephone.trim()) {
    return res.status(400).json({ error: "Le numéro de téléphone du parent est requis pour l'envoi des rapports." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Réutilise un parent existant avec le même numéro, sinon en crée un nouveau
    let { rows } = await client.query("SELECT * FROM parents WHERE telephone = $1", [telephone.trim()]);
    let parent = rows[0];
    if (!parent) {
      const insert = await client.query(
        "INSERT INTO parents (nom, telephone, email) VALUES ($1, $2, $3) RETURNING *",
        [nom || "Parent", telephone.trim(), email || null]
      );
      parent = insert.rows[0];
    }
    await client.query(
      `INSERT INTO student_parents (student_id, parent_id, lien) VALUES ($1, $2, $3)
       ON CONFLICT (student_id, parent_id) DO NOTHING`,
      [req.params.id, parent.id, lien || "parent"]
    );
    await client.query("COMMIT");
    res.status(201).json(parent);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// GET /api/students/:id/parents
router.get("/:id/parents", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.* FROM parents p
     JOIN student_parents sp ON sp.parent_id = p.id
     WHERE sp.student_id = $1`,
    [req.params.id]
  );
  res.json(rows);
});

// GET /api/students/:id — fiche complète d'un élève (pour le dossier élève)
router.get("/:id", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*, c.nom AS classe_nom, c.niveau AS classe_niveau
     FROM students s
     LEFT JOIN classes c ON c.id = s.classe_id
     WHERE s.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Élève introuvable." });
  res.json(rows[0]);
});

// PATCH /api/students/:id  { nom?, matricule?, ... } — correction des informations d'un élève
router.patch("/:id", requireRole("direction", "surveillant", "super_admin"), async (req, res) => {
  const { nom, matricule, date_naissance, lieu_naissance, prenoms, genre, nationalite, nom_pere, nom_mere, affecte } = req.body;
  const rienAModifier = !nom?.trim() && !matricule?.trim() && date_naissance === undefined && lieu_naissance === undefined
    && prenoms === undefined && genre === undefined && nationalite === undefined && nom_pere === undefined && nom_mere === undefined && affecte === undefined;
  if (rienAModifier) {
    return res.status(400).json({ error: "Indique au moins un champ à corriger." });
  }
  if (genre !== undefined && genre !== null && genre !== "" && !["M", "F"].includes(genre)) {
    return res.status(400).json({ error: "Genre invalide (M ou F)." });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE students SET
         nom = COALESCE(NULLIF($1, ''), nom),
         matricule = COALESCE(NULLIF($2, ''), matricule),
         date_naissance = CASE WHEN $3::text IS NOT NULL THEN NULLIF($3, '')::date ELSE date_naissance END,
         lieu_naissance = CASE WHEN $4::text IS NOT NULL THEN NULLIF($4, '') ELSE lieu_naissance END,
         prenoms = CASE WHEN $6::text IS NOT NULL THEN NULLIF($6, '') ELSE prenoms END,
         genre = CASE WHEN $7::text IS NOT NULL THEN NULLIF($7, '') ELSE genre END,
         nationalite = CASE WHEN $8::text IS NOT NULL THEN NULLIF($8, '') ELSE nationalite END,
         nom_pere = CASE WHEN $9::text IS NOT NULL THEN NULLIF($9, '') ELSE nom_pere END,
         nom_mere = CASE WHEN $10::text IS NOT NULL THEN NULLIF($10, '') ELSE nom_mere END,
         affecte = COALESCE($11, affecte)
       WHERE id = $5 RETURNING *`,
      [
        nom?.trim() || "", matricule?.trim() || "",
        date_naissance !== undefined ? date_naissance : null,
        lieu_naissance !== undefined ? lieu_naissance : null,
        req.params.id,
        prenoms !== undefined ? prenoms : null,
        genre !== undefined ? genre : null,
        nationalite !== undefined ? nationalite : null,
        nom_pere !== undefined ? nom_pere : null,
        nom_mere !== undefined ? nom_mere : null,
        affecte !== undefined ? !!affecte : null,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: "Élève introuvable." });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Ce matricule est déjà utilisé par un autre élève." });
    throw err;
  }
});

// POST /api/students/:id/photo — upload/remplacement de la photo d'un élève (pour le badge)
router.post("/:id/photo", requireRole("direction", "surveillant", "super_admin"), upload.single("photo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Aucune photo reçue (champ \"photo\" attendu)." });
  if (!/^image\/(jpeg|jpg|png|webp)$/.test(req.file.mimetype)) {
    return res.status(400).json({ error: "Format non supporté — utilise une image JPEG, PNG ou WebP." });
  }

  const extension = req.file.mimetype === "image/png" ? "png" : req.file.mimetype === "image/webp" ? "webp" : "jpg";
  const nomFichier = `${req.params.id}.${extension}`;
  fs.writeFileSync(path.join(DOSSIER_PHOTOS, nomFichier), req.file.buffer);

  const photoUrl = `/uploads/students/${nomFichier}?v=${Date.now()}`; // ?v= force le rafraîchissement du cache navigateur
  const { rows } = await pool.query("UPDATE students SET photo_url = $1 WHERE id = $2 RETURNING *", [photoUrl, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Élève introuvable." });
  res.json(rows[0]);
});

// GET /api/students/:id/attendance — historique de présence récent (dossier élève)
router.get("/:id/attendance", async (req, res) => {
  const { debut, fin } = req.query;
  const params = [req.params.id];
  let filtreDate = "";
  if (debut && fin) { params.push(debut, fin); filtreDate = `AND ae.horodatage::date BETWEEN $2 AND $3`; }
  const { rows } = await pool.query(
    `SELECT ae.*, cr.matiere, cr.jour_semaine FROM attendance_events ae
     LEFT JOIN creneaux cr ON cr.id = ae.creneau_id
     WHERE ae.student_id = $1 ${filtreDate}
     ORDER BY ae.horodatage DESC ${debut && fin ? "" : "LIMIT 30"}`,
    params
  );
  res.json(rows);
});

// --------------------------------------------------------------------------
// POST /api/students/import — import en masse depuis un fichier Excel (.xlsx) ou CSV
// Colonnes attendues (en-têtes de la première ligne, insensible à la casse) :
//   matricule, nom, classe, parent_nom, parent_telephone, methode_biometrique (optionnel)
// Le nom de "classe" doit correspondre exactement à une classe déjà existante
// dans l'école — les lignes avec une classe introuvable sont rapportées, pas créées.
//
// À savoir : les fichiers Word (.docx) ne sont pas pris en charge — un tableau
// Word doit d'abord être copié dans Excel (ou enregistré en .csv) avant import.
// --------------------------------------------------------------------------
router.post("/import", requireRole("direction", "surveillant"), upload.single("fichier"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu (champ \"fichier\" attendu)." });

  let lignes;
  try {
    const classeur = XLSX.read(req.file.buffer, { type: "buffer" });
    const feuille = classeur.Sheets[classeur.SheetNames[0]];
    lignes = XLSX.utils.sheet_to_json(feuille, { defval: "" });
  } catch (err) {
    return res.status(400).json({ error: "Fichier illisible — vérifie que c'est bien un .xlsx ou .csv valide." });
  }
  if (lignes.length === 0) return res.status(400).json({ error: "Le fichier ne contient aucune ligne de données." });

  // Normalise les noms de colonnes (insensible à la casse/accents/espaces)
  function normaliserCle(k) {
    return k.toString().trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  function valeur(ligne, ...cles) {
    const entree = Object.entries(ligne).find(([k]) => cles.includes(normaliserCle(k)));
    return entree ? String(entree[1]).trim() : "";
  }

  // Pré-charge les classes de l'école pour résoudre "classe" (texte) -> classe_id
  const paramsClasses = [];
  let filtreEcole = "TRUE";
  if (ecoleEffective(req)) { paramsClasses.push(ecoleEffective(req)); filtreEcole = `ecole_id = $${paramsClasses.length}`; }
  const { rows: classesEcole } = await pool.query(`SELECT id, nom FROM classes WHERE ${filtreEcole}`, paramsClasses);
  const classeParNom = new Map(classesEcole.map((c) => [c.nom.trim().toLowerCase(), c.id]));

  const crees = [];
  const erreurs = [];

  for (let i = 0; i < lignes.length; i++) {
    const ligne = lignes[i];
    const numeroLigne = i + 2; // +2 : ligne 1 = en-têtes, tableur compte à partir de 1

    const matricule = valeur(ligne, "matricule");
    const nom = valeur(ligne, "nom", "nom complet", "eleve", "élève");
    const classeTexte = valeur(ligne, "classe");
    const parentNom = valeur(ligne, "parent_nom", "nom du parent", "parent");
    const parentTelephone = valeur(ligne, "parent_telephone", "telephone parent", "téléphone parent", "telephone", "téléphone");
    const methode = valeur(ligne, "methode_biometrique", "methode", "méthode") || "aucune";

    if (!matricule || !nom) {
      erreurs.push({ ligne: numeroLigne, raison: "Matricule ou nom manquant." });
      continue;
    }
    if (!parentTelephone) {
      erreurs.push({ ligne: numeroLigne, raison: "Téléphone du parent manquant (obligatoire à l'inscription)." });
      continue;
    }
    let classeId = null;
    if (classeTexte) {
      classeId = classeParNom.get(classeTexte.trim().toLowerCase()) || null;
      if (!classeId) {
        erreurs.push({ ligne: numeroLigne, raison: `Classe "${classeTexte}" introuvable dans ton école.` });
        continue;
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO students (matricule, nom, classe_id, methode_biometrique)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [matricule, nom, classeId, methode]
      );
      const student = rows[0];
      const token = genererJetonEleve(student.id, student.matricule);
      await client.query("UPDATE students SET qr_token = $1 WHERE id = $2", [token, student.id]);

      let { rows: parentRows } = await client.query("SELECT * FROM parents WHERE telephone = $1", [parentTelephone]);
      let parent = parentRows[0];
      if (!parent) {
        const insert = await client.query(
          "INSERT INTO parents (nom, telephone) VALUES ($1, $2) RETURNING *",
          [parentNom || "Parent", parentTelephone]
        );
        parent = insert.rows[0];
      }
      await client.query(
        "INSERT INTO student_parents (student_id, parent_id, lien) VALUES ($1, $2, 'parent') ON CONFLICT DO NOTHING",
        [student.id, parent.id]
      );

      await client.query("COMMIT");
      crees.push({ ligne: numeroLigne, nom, matricule });
    } catch (err) {
      await client.query("ROLLBACK");
      if (err.code === "23505") {
        erreurs.push({ ligne: numeroLigne, raison: `Matricule "${matricule}" déjà utilisé.` });
      } else {
        erreurs.push({ ligne: numeroLigne, raison: "Erreur inattendue : " + err.message });
      }
    } finally {
      client.release();
    }
  }

  res.status(201).json({ total_lignes: lignes.length, crees: crees.length, erreurs, details_crees: crees });
});

module.exports = router;
