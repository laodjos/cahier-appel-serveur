const jwt = require("jsonwebtoken");
const { pool } = require("../config/db");

function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentification requise." });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Jeton invalide ou expiré." });
  }
}

// Authentification d'un parent (Espace Parent) — jeton distinct de celui du
// personnel (typ: "parent"), obtenu après vérification du code SMS.
function authRequiredParent(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentification requise." });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.typ !== "parent") return res.status(401).json({ error: "Jeton invalide pour l'espace parent." });
    req.parent = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Session expirée — reconnecte-toi." });
  }
}

// Restreint l'accès à certains rôles, ex. requireRole("direction", "surveillant")
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Accès non autorisé pour ce rôle." });
    }
    next();
  };
}

// Bloque l'accès aux routes du module ERP (notes/bulletins, frais de scolarité)
// tant que l'établissement concerné n'a pas activé cette option payante séparée.
// Le Super-administrateur passe toujours, même sans ecole_id précisé (utile
// pour parcourir les réglages globaux du module).
async function requireErpActif(req, res, next) {
  if (req.user.role === "super_admin") return next();
  const ecoleId = req.user.ecole_id || req.query?.ecole_id || req.body?.ecole_id || null;
  if (!ecoleId) return res.status(403).json({ error: "Aucune école déterminée pour vérifier l'accès au module ERP." });
  const { rows } = await pool.query("SELECT erp_actif FROM ecoles WHERE id = $1", [ecoleId]);
  if (!rows[0]?.erp_actif) {
    return res.status(403).json({ error: "Le module ERP n'est pas activé pour cet établissement. Contacte l'administrateur du système." });
  }
  next();
}

// Authentification du petit programme "agent" local (relais des lecteurs
// biométriques) — pas de compte utilisateur, juste la clé secrète de l'école,
// envoyée dans l'en-tête X-Agent-Key.
async function authAgent(req, res, next) {
  const cle = req.headers["x-agent-key"];
  if (!cle) return res.status(401).json({ error: "En-tête X-Agent-Key manquant." });

  const { rows } = await pool.query("SELECT * FROM ecoles WHERE cle_agent = $1", [cle]);
  if (!rows[0]) return res.status(401).json({ error: "Clé d'agent invalide." });

  req.ecoleAgent = rows[0];
  next();
}

module.exports = { authRequired, authRequiredParent, requireRole, requireErpActif, authAgent };
