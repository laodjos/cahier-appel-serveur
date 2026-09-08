const express = require("express");
const { pool } = require("../config/db");
const { authRequired, requireRole, requireErpActif } = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);
router.use(requireErpActif);

function ecoleEffective(req) {
  if (req.user.ecole_id) return req.user.ecole_id;
  return req.query?.ecole_id || req.body?.ecole_id || null;
}

function calculerEtatCaisse(paiementsScolarite, mouvements) {
  const entreesScolarite = paiementsScolarite.reduce((s, p) => s + Number(p.montant), 0);
  const entreesManuelles = mouvements.filter((m) => m.type === "entree").reduce((s, m) => s + Number(m.montant), 0);
  const sorties = mouvements.filter((m) => m.type === "sortie").reduce((s, m) => s + Number(m.montant), 0);
  const totalEntrees = entreesScolarite + entreesManuelles;
  return { entrees_scolarite: entreesScolarite, entrees_manuelles: entreesManuelles, total_entrees: totalEntrees, total_sorties: sorties, solde_net: totalEntrees - sorties };
}

// GET /api/caisse/mouvements?debut=&fin=
router.get("/mouvements", async (req, res) => {
  const { debut, fin } = req.query;
  const params = [];
  let filtre = "TRUE";
  const ecoleId = ecoleEffective(req);
  if (ecoleId) { params.push(ecoleId); filtre += ` AND ecole_id = $${params.length}`; }
  if (debut) { params.push(debut); filtre += ` AND created_at::date >= $${params.length}`; }
  if (fin) { params.push(fin); filtre += ` AND created_at::date <= $${params.length}`; }
  const { rows } = await pool.query(`SELECT * FROM mouvements_caisse WHERE ${filtre} ORDER BY created_at DESC`, params);
  res.json(rows);
});

// POST /api/caisse/mouvements  { type, categorie, libelle, montant }
// Un caissier peut ENREGISTRER un mouvement, mais ni le modifier ni le
// supprimer ensuite — seule la Direction peut corriger une erreur de saisie.
router.post("/mouvements", requireRole("direction", "super_admin", "caissier"), async (req, res) => {
  const { type, categorie, libelle, montant } = req.body;
  if (!["entree", "sortie"].includes(type)) return res.status(400).json({ error: "type doit être 'entree' ou 'sortie'." });
  if (!libelle || !libelle.trim()) return res.status(400).json({ error: "Le libellé est requis." });
  if (!montant || Number(montant) <= 0) return res.status(400).json({ error: "Montant invalide." });
  const ecoleId = ecoleEffective(req);
  const { rows } = await pool.query(
    `INSERT INTO mouvements_caisse (ecole_id, type, categorie, libelle, montant, saisi_par)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [ecoleId, type, categorie || null, libelle.trim(), montant, req.user.sub]
  );
  res.status(201).json(rows[0]);
});

// DELETE /api/caisse/mouvements/:id — réservé à la Direction (correction d'erreur),
// jamais au caissier, qui ne doit rien pouvoir effacer une fois saisi.
router.delete("/mouvements/:id", requireRole("direction", "super_admin"), async (req, res) => {
  await pool.query("DELETE FROM mouvements_caisse WHERE id = $1", [req.params.id]);
  res.status(204).send();
});

// GET /api/caisse/etat?debut=&fin= — état de caisse consolidé (paiements de
// scolarité + mouvements manuels) sur une période, par défaut la journée en cours.
router.get("/etat", async (req, res) => {
  const debut = req.query.debut || new Date().toISOString().slice(0, 10);
  const fin = req.query.fin || debut;
  const ecoleId = ecoleEffective(req);

  const paramsPaiements = [debut, fin];
  let filtrePaiements = "statut = 'reussi' AND confirme_at::date >= $1 AND confirme_at::date <= $2";
  if (ecoleId) {
    paramsPaiements.push(ecoleId);
    filtrePaiements += ` AND eleve_id IN (SELECT s.id FROM students s JOIN classes c ON c.id = s.classe_id WHERE c.ecole_id = $${paramsPaiements.length})`;
  }
  const { rows: paiements } = await pool.query(
    `SELECT ps.*, s.nom AS eleve_nom FROM paiements_scolarite ps JOIN students s ON s.id = ps.eleve_id WHERE ${filtrePaiements} ORDER BY ps.confirme_at`,
    paramsPaiements
  );

  const paramsMouvements = [debut, fin];
  let filtreMouvements = "created_at::date >= $1 AND created_at::date <= $2";
  if (ecoleId) { paramsMouvements.push(ecoleId); filtreMouvements += ` AND ecole_id = $${paramsMouvements.length}`; }
  const { rows: mouvements } = await pool.query(
    `SELECT * FROM mouvements_caisse WHERE ${filtreMouvements} ORDER BY created_at`, paramsMouvements
  );

  const etat = calculerEtatCaisse(paiements, mouvements);
  res.json({ debut, fin, paiements_scolarite: paiements, mouvements, ...etat });
});

module.exports = router;
