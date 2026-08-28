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

// Restreint l'accès à certains rôles, ex. requireRole("direction", "surveillant")
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Accès non autorisé pour ce rôle." });
    }
    next();
  };
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

module.exports = { authRequired, requireRole, authAgent };
