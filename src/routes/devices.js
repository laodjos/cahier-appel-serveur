const express = require("express");
const { pool } = require("../config/db");
const { authRequired, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);

function ecoleEffective(req) {
  if (req.user.ecole_id) return req.user.ecole_id;
  return req.query?.ecole_id || req.body?.ecole_id || null;
}

function clauseEcole(req, params, colonne = "ecole_id") {
  const ecoleId = ecoleEffective(req);
  if (ecoleId) {
    params.push(ecoleId);
    return `${colonne} = $${params.length}`;
  }
  return "TRUE";
}

// GET /api/devices
router.get("/", async (req, res) => {
  const params = [];
  const filtreEcole = clauseEcole(req, params);
  const { rows } = await pool.query(`SELECT * FROM devices WHERE ${filtreEcole} ORDER BY nom`, params);
  res.json(rows);
});

// POST /api/devices  { nom, marque, adresse_ip, emplacement, ecole_id? }
router.post("/", requireRole("direction", "super_admin"), async (req, res) => {
  const { nom, marque, adresse_ip, emplacement } = req.body;
  if (!nom || !marque || !adresse_ip) return res.status(400).json({ error: "nom, marque et adresse_ip requis." });
  const ecoleCible = ecoleEffective(req);
  if (!ecoleCible) {
    return res.status(400).json({ error: "Choisis d'abord une école avant d'ajouter un lecteur." });
  }
  const { rows } = await pool.query(
    "INSERT INTO devices (nom, marque, adresse_ip, emplacement, ecole_id) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [nom, marque, adresse_ip, emplacement || null, ecoleCible]
  );
  res.status(201).json(rows[0]);
});

// PUT /api/devices/:id
router.put("/:id", requireRole("direction", "super_admin"), async (req, res) => {
  const { nom, marque, adresse_ip, emplacement } = req.body;
  if (!nom || !marque || !adresse_ip) return res.status(400).json({ error: "nom, marque et adresse_ip requis." });
  const params = [nom, marque, adresse_ip, emplacement || null, req.params.id];
  const filtreEcole = clauseEcole(req, params);
  const { rows } = await pool.query(
    `UPDATE devices SET nom=$1, marque=$2, adresse_ip=$3, emplacement=$4 WHERE id=$5 AND ${filtreEcole} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: "Lecteur introuvable (ou hors de ton école)." });
  res.json(rows[0]);
});

// DELETE /api/devices/:id
router.delete("/:id", requireRole("direction", "super_admin"), async (req, res) => {
  const params = [req.params.id];
  const filtreEcole = clauseEcole(req, params);
  const { rowCount } = await pool.query(`DELETE FROM devices WHERE id = $1 AND ${filtreEcole}`, params);
  if (rowCount === 0) return res.status(404).json({ error: "Lecteur introuvable (ou hors de ton école)." });
  res.status(204).send();
});

// GET /api/devices/incidents/journal
router.get("/incidents/journal", async (req, res) => {
  const params = [];
  const filtreEcole = clauseEcole(req, params, "d.ecole_id");
  const { rows } = await pool.query(
    `SELECT di.*, d.nom AS device_nom FROM device_incidents di
     JOIN devices d ON d.id = di.device_id
     WHERE ${filtreEcole}
     ORDER BY di.created_at DESC LIMIT 50`,
    params
  );
  res.json(rows);
});

// POST /api/devices/:id/tester — test de connexion immédiat, à la demande (sans attendre le prochain cycle)
router.post("/:id/tester", requireRole("direction", "super_admin"), async (req, res) => {
  const params = [req.params.id];
  const filtreEcole = clauseEcole(req, params);
  const { rows } = await pool.query(`SELECT * FROM devices WHERE id = $1 AND ${filtreEcole}`, params);
  const device = rows[0];
  if (!device) return res.status(404).json({ error: "Lecteur introuvable (ou hors de ton école)." });

  const debut = Date.now();
  let resultat;
  if (device.marque === "zkteco") {
    const { synchroniserLecteurZkteco } = require("../connectors/zktecoConnector");
    resultat = await synchroniserLecteurZkteco(device);
  } else {
    const { synchroniserLecteurHikvision } = require("../connectors/hikvisionConnector");
    resultat = await synchroniserLecteurHikvision(device, {
      utilisateur: process.env.HIKVISION_1_USER,
      motDePasse: process.env.HIKVISION_1_PASSWORD,
    });
  }
  const dureeMs = Date.now() - debut;

  if (resultat.ok) {
    await pool.query("UPDATE devices SET en_ligne = true WHERE id = $1", [device.id]);
  }
  res.json({ ok: resultat.ok, duree_ms: dureeMs, erreur: resultat.error || null });
});

module.exports = router;
