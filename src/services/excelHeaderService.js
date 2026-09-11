const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { pool } = require("../config/db");
const { UPLOAD_DIR } = require("../config/uploadDir");

// Construit un classeur Excel avec un en-tête commun à tous les exports :
// logo de l'établissement (si disponible), nom de l'école, année académique
// en cours, titre du rapport et date d'édition — pour qu'un document
// téléchargé reste identifiable une fois imprimé ou transmis, hors contexte.
async function creerClasseurAvecEntete(ecoleId, titreRapport, nomFeuille) {
  const { rows } = await pool.query(
    `SELECT e.nom, e.logo_url, a.libelle AS annee_scolaire
     FROM ecoles e LEFT JOIN annees_scolaires a ON a.id = e.annee_scolaire_id
     WHERE e.id = $1`,
    [ecoleId]
  );
  const ecole = rows[0] || {};

  const classeur = new ExcelJS.Workbook();
  const feuille = classeur.addWorksheet(nomFeuille || "Feuille 1");

  let colonneTexteEntete = "A";
  if (ecole.logo_url) {
    try {
      // logo_url ressemble à "/uploads/ecoles/logo-xxx.png?v=..." — on retrouve
      // le fichier réel sur le disque à partir de son nom, sans dépendre du
      // domaine ni d'une requête HTTP.
      const nomFichier = path.basename(ecole.logo_url.split("?")[0]);
      const cheminFichier = path.join(UPLOAD_DIR, "ecoles", nomFichier);
      if (fs.existsSync(cheminFichier)) {
        const extension = path.extname(nomFichier).slice(1).toLowerCase();
        const extensionValide = ["png", "jpeg", "jpg"].includes(extension) ? (extension === "jpg" ? "jpeg" : extension) : "png";
        const imageId = classeur.addImage({ buffer: fs.readFileSync(cheminFichier), extension: extensionValide });
        feuille.addImage(imageId, "A1:B4");
        colonneTexteEntete = "C";
      }
    } catch (err) {
      console.error("Logo non inclus dans l'export Excel (fichier introuvable ou illisible) :", err.message);
    }
  }

  feuille.getCell(`${colonneTexteEntete}1`).value = ecole.nom || "";
  feuille.getCell(`${colonneTexteEntete}1`).font = { bold: true, size: 14 };
  feuille.getCell(`${colonneTexteEntete}2`).value = `Année académique : ${ecole.annee_scolaire || "Non renseignée"}`;
  feuille.getCell(`${colonneTexteEntete}3`).value = `Rapport : ${titreRapport}`;
  feuille.getCell(`${colonneTexteEntete}4`).value = `Édité le : ${new Date().toLocaleDateString("fr-FR")}`;
  feuille.addRow([]); // ligne 5 : espace avant le tableau de données

  return { classeur, feuille };
}

module.exports = { creerClasseurAvecEntete };
