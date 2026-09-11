const jwt = require("jsonwebtoken");

// Le port est fixé ici plutôt que de dépendre uniquement de process.env, qui
// peut ne pas se propager correctement entre le processus de globalSetup et
// les workers Jest selon la configuration.
const PORT = process.env.TEST_PORT || 4321;
const BASE_URL = process.env.TEST_BASE_URL || `http://localhost:${PORT}/api`;
const JWT_SECRET = "test-secret-key-for-automated-tests";

function creerToken({ sub, role, nom, ecole_id }) {
  return jwt.sign({ sub, role, nom, ecole_id }, JWT_SECRET, { expiresIn: "1h" });
}

async function appelApi(chemin, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE_URL}${chemin}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const texte = await res.text();
  let data = null;
  try { data = texte ? JSON.parse(texte) : null; } catch (e) { data = texte; }
  return { status: res.status, ok: res.ok, data };
}

module.exports = { BASE_URL, creerToken, appelApi };
