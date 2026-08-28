const { Pool } = require("pg");

// Les bases de données hébergées en ligne (Neon, Supabase, etc.) exigent une
// connexion chiffrée (SSL). On l'active automatiquement si l'adresse le suggère,
// pour ne pas avoir à y penser en changeant de fournisseur.
const url = process.env.DATABASE_URL || "";
const necessiteSSL = /sslmode=require|neon\.tech|supabase\.co|render\.com/.test(url);

const pool = new Pool({
  connectionString: url,
  ssl: necessiteSSL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  console.error("Erreur inattendue sur le pool PostgreSQL :", err);
});

module.exports = { pool };
