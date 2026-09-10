const express = require("express");
const { pool } = require("../config/db");
const { authRequired, requireRole, requireErpActif } = require("../middleware/auth");
const { normaliserNumeroCi } = require("../services/notificationService");

const router = express.Router();
router.use(authRequired);
router.use(requireErpActif);

function ecoleEffective(req) {
  if (req.user.ecole_id) return req.user.ecole_id;
  return req.query?.ecole_id || req.body?.ecole_id || null;
}

// Additionne un ensemble de mouvements (entrées positives, sorties négatives).
function solderMouvements(liste) {
  return liste.reduce((s, m) => s + (m.type === "entree" ? Number(m.montant) : -Number(m.montant)), 0);
}

// GET /api/caisses — toutes les caisses de l'école
router.get("/", async (req, res) => {
  const ecoleId = ecoleEffective(req);
  if (!ecoleId) return res.status(400).json({ error: "Choisis d'abord une école." });
  const { rows } = await pool.query(
    `SELECT c.*, u.nom AS responsable_nom FROM caisses c
     LEFT JOIN users u ON u.id = c.responsable_id
     WHERE c.ecole_id = $1 ORDER BY c.est_principale DESC, c.nom`,
    [ecoleId]
  );
  res.json(rows);
});

// POST /api/caisses  { nom, est_principale?, responsable_id? }
router.post("/", requireRole("direction", "super_admin"), async (req, res) => {
  const { nom, est_principale, responsable_id } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: "Le nom de la caisse est requis." });
  const ecoleId = ecoleEffective(req);
  if (!ecoleId) return res.status(400).json({ error: "Choisis d'abord une école." });

  // Une seule caisse principale par école — en désigner une nouvelle retire
  // le statut à l'ancienne, plutôt que d'en avoir plusieurs à la fois.
  if (est_principale) {
    await pool.query("UPDATE caisses SET est_principale = false WHERE ecole_id = $1", [ecoleId]);
  }
  const { rows } = await pool.query(
    "INSERT INTO caisses (ecole_id, nom, est_principale, responsable_id) VALUES ($1, $2, $3, $4) RETURNING *",
    [ecoleId, nom.trim(), !!est_principale, responsable_id || null]
  );
  res.status(201).json(rows[0]);
});

// PATCH /api/caisses/:id/responsable  { responsable_id }
router.patch("/:id/responsable", requireRole("direction", "super_admin"), async (req, res) => {
  const { responsable_id } = req.body;
  const { rows } = await pool.query(
    `UPDATE caisses SET responsable_id = $1 WHERE id = $2
     RETURNING *, (SELECT nom FROM users WHERE id = $1) AS responsable_nom`,
    [responsable_id || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Caisse introuvable." });
  res.json(rows[0]);
});

// PATCH /api/caisses/:id/principale — désigne cette caisse comme la principale
router.patch("/:id/principale", requireRole("direction", "super_admin"), async (req, res) => {
  const { rows: caisseRows } = await pool.query("SELECT * FROM caisses WHERE id = $1", [req.params.id]);
  if (!caisseRows[0]) return res.status(404).json({ error: "Caisse introuvable." });
  await pool.query("UPDATE caisses SET est_principale = false WHERE ecole_id = $1", [caisseRows[0].ecole_id]);
  const { rows } = await pool.query("UPDATE caisses SET est_principale = true WHERE id = $1 RETURNING *", [req.params.id]);
  res.json(rows[0]);
});

// DELETE /api/caisses/:id
router.delete("/:id", requireRole("direction", "super_admin"), async (req, res) => {
  await pool.query("DELETE FROM caisses WHERE id = $1", [req.params.id]);
  res.status(204).send();
});

// GET /api/caisses/:id/solde — solde d'ouverture (avant aujourd'hui), les
// mouvements du jour, et le solde actuel — pour afficher "où on en est" dès
// l'ouverture de la caisse, sans avoir à cumuler soi-même l'historique.
router.get("/:id/solde", async (req, res) => {
  try {
    const { rows: mouvementsAvant } = await pool.query(
      "SELECT type, montant FROM mouvements_caisse WHERE caisse_id = $1 AND created_at::date < CURRENT_DATE",
      [req.params.id]
    );
    const { rows: mouvementsAujourdhui } = await pool.query(
      "SELECT * FROM mouvements_caisse WHERE caisse_id = $1 AND created_at::date = CURRENT_DATE ORDER BY created_at",
      [req.params.id]
    );
    const { rows: paiementsAvant } = await pool.query(
      "SELECT montant FROM paiements_scolarite WHERE caisse_id = $1 AND statut = 'reussi' AND confirme_at::date < CURRENT_DATE",
      [req.params.id]
    );
    const { rows: paiementsAujourdhui } = await pool.query(
      `SELECT ps.*, s.nom AS eleve_nom, s.prenoms AS eleve_prenoms FROM paiements_scolarite ps
       LEFT JOIN students s ON s.id = ps.eleve_id
       WHERE ps.caisse_id = $1 AND ps.statut = 'reussi' AND ps.confirme_at::date = CURRENT_DATE ORDER BY ps.confirme_at`,
      [req.params.id]
    );

    const soldeOuverture = solderMouvements(mouvementsAvant) + paiementsAvant.reduce((s, p) => s + Number(p.montant), 0);
    const variationJour = solderMouvements(mouvementsAujourdhui) + paiementsAujourdhui.reduce((s, p) => s + Number(p.montant), 0);

    res.json({
      solde_ouverture: soldeOuverture,
      solde_actuel: soldeOuverture + variationJour,
      mouvements_du_jour: mouvementsAujourdhui,
      paiements_du_jour: paiementsAujourdhui,
    });
  } catch (err) {
    console.error("Erreur solde caisse :", err);
    res.status(500).json({ error: "Impossible de calculer le solde de cette caisse pour le moment." });
  }
});

// POST /api/caisses/:id/rapport-whatsapp  { type: 'ouverture'|'fermeture', telephone }
// Construit le rapport d'ouverture ou de fermeture de caisse et renvoie un
// lien WhatsApp prêt à envoyer (au responsable de l'établissement, ou à qui
// le caissier veut) — même principe que le reste de l'envoi WhatsApp manuel.
router.post("/:id/rapport-whatsapp", async (req, res) => {
  const { type, telephone } = req.body;
  if (!["ouverture", "fermeture"].includes(type)) return res.status(400).json({ error: "type doit être 'ouverture' ou 'fermeture'." });
  if (!telephone) return res.status(400).json({ error: "Numéro de téléphone du destinataire requis." });

  try {
    const { rows: caisseRows } = await pool.query("SELECT nom FROM caisses WHERE id = $1", [req.params.id]);
    if (!caisseRows[0]) return res.status(404).json({ error: "Caisse introuvable." });

    const { rows: mouvementsAvant } = await pool.query(
      "SELECT type, montant FROM mouvements_caisse WHERE caisse_id = $1 AND created_at::date < CURRENT_DATE", [req.params.id]
    );
    const { rows: mouvementsAujourdhui } = await pool.query(
      "SELECT type, montant FROM mouvements_caisse WHERE caisse_id = $1 AND created_at::date = CURRENT_DATE", [req.params.id]
    );
    const { rows: paiementsAvant } = await pool.query(
      "SELECT montant FROM paiements_scolarite WHERE caisse_id = $1 AND statut = 'reussi' AND confirme_at::date < CURRENT_DATE", [req.params.id]
    );
    const { rows: paiementsAujourdhui } = await pool.query(
      "SELECT montant FROM paiements_scolarite WHERE caisse_id = $1 AND statut = 'reussi' AND confirme_at::date = CURRENT_DATE", [req.params.id]
    );
    const soldeOuverture = solderMouvements(mouvementsAvant) + paiementsAvant.reduce((s, p) => s + Number(p.montant), 0);
    const variationJour = solderMouvements(mouvementsAujourdhui) + paiementsAujourdhui.reduce((s, p) => s + Number(p.montant), 0);
    const soldeActuel = soldeOuverture + variationJour;

    const formatMontant = (n) => Number(n).toLocaleString("fr-FR") + " F";
    const maintenant = new Date().toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" });
    const nomCaisse = caisseRows[0].nom;
    const nomUtilisateur = req.user.nom || "Un caissier";

    const message = type === "ouverture"
      ? `Ouverture de caisse — ${nomCaisse}\nPar : ${nomUtilisateur}\nLe : ${maintenant}\n\nSolde d'ouverture : ${formatMontant(soldeOuverture)}`
      : `Clôture de caisse — ${nomCaisse}\nPar : ${nomUtilisateur}\nLe : ${maintenant}\n\nSolde d'ouverture (ce matin) : ${formatMontant(soldeOuverture)}\nMouvements du jour : ${variationJour >= 0 ? "+" : ""}${formatMontant(variationJour)}\nSolde de clôture : ${formatMontant(soldeActuel)}`;

    const lienWhatsapp = `https://wa.me/${normaliserNumeroCi(telephone)}?text=${encodeURIComponent(message)}`;
    res.json({ message, lien_whatsapp: lienWhatsapp });
  } catch (err) {
    console.error("Erreur rapport WhatsApp caisse :", err);
    res.status(500).json({ error: "Impossible de générer le rapport pour le moment." });
  }
});

// GET /api/caisses/principale/vue-ensemble — pour la caisse marquée comme
// principale : le solde de TOUTES les caisses de l'école, pour voir en un
// coup d'œil ce que chaque caisse secondaire a encaissé.
router.get("/principale/vue-ensemble", async (req, res) => {
  const ecoleId = ecoleEffective(req);
  if (!ecoleId) return res.status(400).json({ error: "Choisis d'abord une école." });
  try {
    const { rows: caissesEcole } = await pool.query("SELECT * FROM caisses WHERE ecole_id = $1 ORDER BY est_principale DESC, nom", [ecoleId]);
    const resultats = [];
    for (const c of caissesEcole) {
      const { rows: mouvements } = await pool.query("SELECT type, montant FROM mouvements_caisse WHERE caisse_id = $1", [c.id]);
      const { rows: paiements } = await pool.query("SELECT montant FROM paiements_scolarite WHERE caisse_id = $1 AND statut = 'reussi'", [c.id]);
      const solde = solderMouvements(mouvements) + paiements.reduce((s, p) => s + Number(p.montant), 0);
      resultats.push({ caisse: c, solde_actuel: solde });
    }
    res.json(resultats);
  } catch (err) {
    console.error("Erreur vue d'ensemble caisse principale :", err);
    res.status(500).json({ error: "Impossible de charger la vue d'ensemble pour le moment." });
  }
});

// POST /api/caisses/transfert  { caisse_source_id, caisse_destination_id, montant, libelle? }
// Crée une sortie dans la caisse source et une entrée miroir dans la
// destination, dans la même transaction (les deux réussissent ou aucune).
router.post("/transfert", requireRole("direction", "super_admin", "caissier"), async (req, res) => {
  const { caisse_source_id, caisse_destination_id, montant, libelle } = req.body;
  if (!caisse_source_id || !caisse_destination_id) return res.status(400).json({ error: "caisse_source_id et caisse_destination_id sont requis." });
  if (caisse_source_id === caisse_destination_id) return res.status(400).json({ error: "La caisse source et la caisse destination doivent être différentes." });
  if (!montant || Number(montant) <= 0) return res.status(400).json({ error: "Montant invalide." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: source } = await client.query("SELECT nom FROM caisses WHERE id = $1", [caisse_source_id]);
    const { rows: destination } = await client.query("SELECT nom FROM caisses WHERE id = $1", [caisse_destination_id]);
    if (!source[0] || !destination[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Caisse source ou destination introuvable." });
    }
    const ecoleId = ecoleEffective(req);
    const libelleFinal = libelle?.trim() || `Transfert ${source[0].nom} vers ${destination[0].nom}`;
    await client.query(
      `INSERT INTO mouvements_caisse (ecole_id, caisse_id, type, categorie, libelle, montant, saisi_par, caisse_destination_id)
       VALUES ($1, $2, 'sortie', 'transfert', $3, $4, $5, $6)`,
      [ecoleId, caisse_source_id, libelleFinal, montant, req.user.sub, caisse_destination_id]
    );
    await client.query(
      `INSERT INTO mouvements_caisse (ecole_id, caisse_id, type, categorie, libelle, montant, saisi_par)
       VALUES ($1, $2, 'entree', 'transfert', $3, $4, $5)`,
      [ecoleId, caisse_destination_id, libelleFinal, montant, req.user.sub]
    );
    await client.query("COMMIT");
    res.status(201).json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erreur transfert de caisse :", err);
    res.status(500).json({ error: "Impossible d'effectuer ce transfert pour le moment." });
  } finally {
    client.release();
  }
});

module.exports = router;
