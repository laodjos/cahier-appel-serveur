require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const authRoutes = require("./routes/auth");
const classesRoutes = require("./routes/classes");
const studentsRoutes = require("./routes/students");
const creneauxRoutes = require("./routes/creneaux");
const attendanceRoutes = require("./routes/attendance");
const notificationsRoutes = require("./routes/notifications");
const devicesRoutes = require("./routes/devices");
const usersRoutes = require("./routes/users");
const ecolesRoutes = require("./routes/ecoles");
const joursNonScolairesRoutes = require("./routes/joursNonScolaires");
const agentRoutes = require("./routes/agent");

const { demarrerPollingLecteurs, demarrerEnvoiNotifications } = require("./jobs/scheduler");

const app = express();

app.use(helmet({ contentSecurityPolicy: false })); // CSP désactivée : on sert nous-mêmes tout le JS, pas de source externe à autoriser
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
app.use(morgan("combined"));

// --------------------------------------------------------------------------
// Sert l'interface web ET les bibliothèques (React, ReactDOM, Babel) en local.
// Objectif : la page n'a besoin d'aucune connexion internet à l'ouverture —
// tout vient de ce même serveur, ce qui évite les blocages de pare-feu sur
// des CDN externes (unpkg.com, jsdelivr.net, etc.).
// --------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("/vendor/react.production.min.js", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "node_modules", "react", "umd", "react.production.min.js"));
});
app.get("/vendor/react-dom.production.min.js", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "node_modules", "react-dom", "umd", "react-dom.production.min.js"));
});
app.get("/vendor/babel.min.js", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "node_modules", "@babel", "standalone", "babel.min.js"));
});

app.get("/api/health", (req, res) => res.json({ ok: true, heure: new Date().toISOString() }));

app.use("/api/auth", authRoutes);
app.use("/api/classes", classesRoutes);
app.use("/api/students", studentsRoutes);
app.use("/api/creneaux", creneauxRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/devices", devicesRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/ecoles", ecolesRoutes);
app.use("/api/jours-non-scolaires", joursNonScolairesRoutes);
app.use("/api/agent", agentRoutes);

// Gestion d'erreurs centralisée
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Erreur interne du serveur." });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✔ Cahier d'Appel — backend démarré sur le port ${PORT}`);

  // Le polling direct des lecteurs (ZKTeco/Hikvision) ne fonctionne QUE si ce
  // serveur tourne sur le MÊME réseau local que les lecteurs — ce qui n'est plus
  // le cas une fois hébergé sur internet (Render, etc.). Dans ce cas, c'est le
  // petit programme "agent-local" qui s'en charge à la place, via /api/agent/*.
  // Mets ACTIVER_POLLING_LOCAL=true dans les variables d'environnement UNIQUEMENT
  // si ce serveur est installé directement sur le réseau de l'école.
  if (process.env.ACTIVER_POLLING_LOCAL === "true") {
    console.log("⏱  Polling local des lecteurs activé (ACTIVER_POLLING_LOCAL=true)");
    demarrerPollingLecteurs();
  } else {
    console.log("ℹ  Polling local des lecteurs désactivé — utilise l'agent-local pour relayer les lecteurs biométriques.");
  }
  demarrerEnvoiNotifications();
});
