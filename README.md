# Cahier d'Appel — Backend

Backend du système d'appel numérique scolaire :
- Pointage à l'entrée de l'établissement via lecteurs **ZKTeco** et **Hikvision** (réseau)
- Appel en classe via **scan QR code** (tablette/smartphone), avec correction manuelle en secours
- Notifications aux parents (immédiates ou différées) via l'application mobile
- Suivi de l'absentéisme, rapports

## 1. Prérequis

- Node.js 18+
- PostgreSQL 14+
- Les lecteurs ZKTeco et Hikvision doivent être accessibles sur le même réseau que le serveur (IP fixe recommandée)

## 2. Installation

```bash
cd cahier-appel-backend
npm install
cp .env.example .env
```

Ouvrez `.env` et renseignez :
- `DATABASE_URL` — connexion à votre base PostgreSQL
- `JWT_SECRET` et `QR_SECRET` — deux valeurs longues et aléatoires (ex. `openssl rand -hex 32`)
- Les IP et identifiants de vos lecteurs ZKTeco / Hikvision
- Le fournisseur de notifications (`expo` recommandé pour démarrer simplement avec une appli React Native)

## 3. Créer la base de données

```bash
createdb cahier_appel        # ou via votre outil d'administration PostgreSQL habituel
npm run migrate              # applique src/db/schema.sql
```

## 4. Déclarer vos lecteurs biométriques

Le schéma prévoit une table `devices`. Ajoutez vos lecteurs directement en base au démarrage :

```sql
INSERT INTO devices (nom, marque, adresse_ip, emplacement) VALUES
  ('ZKTeco - Portail Nord', 'zkteco', '192.168.1.201', 'Portail Nord'),
  ('Hikvision - Portail Sud', 'hikvision', '192.168.1.202', 'Portail Sud');
```

## 5. Créer un premier compte administrateur (Direction)

```bash
node -e "
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./src/config/db');
(async () => {
  const hash = await bcrypt.hash('changez-ce-mot-de-passe', 10);
  await pool.query(
    'INSERT INTO users (nom, email, mot_de_passe_hash, role) VALUES (\$1,\$2,\$3,\$4)',
    ['Directeur', 'direction@ecole.example', hash, 'direction']
  );
  console.log('Compte créé.');
  process.exit(0);
})();
"
```

## 6. Démarrer le serveur

```bash
npm start          # production
npm run dev         # développement, avec redémarrage automatique
```

Le serveur écoute par défaut sur `http://localhost:4000`. Vérifiez avec :

```bash
curl http://localhost:4000/api/health
```

## 7. Modifier l'interface (frontend)

L'interface (`public/app.jsx`) est écrite en JSX lisible, mais ce n'est **pas**
ce fichier qui est servi aux visiteurs — pour ne pas exposer le code source en
clair dans le navigateur, une version compilée et minifiée
(`public/app.min.js`) est générée à partir de lui, et c'est **cette version
minifiée** que charge `public/index.html`.

**Concrètement, à chaque modification de `public/app.jsx` :**

```bash
npm run build
```

Ceci régénère `public/app.min.js` à partir de `public/app.jsx`. Sans cette
étape, tes modifications resteront invisibles pour les visiteurs — seul
`app.min.js` est réellement chargé en production.

Ne modifie jamais `public/app.min.js` directement (il est régénéré à chaque
`npm run build` et toute modification manuelle serait perdue) — modifie
toujours `public/app.jsx`, la source lisible.

## 8. Fonctionnement des connecteurs biométriques

- **ZKTeco** : le serveur interroge le lecteur toutes les `ZKTECO_POLL_INTERVAL_SECONDS` secondes (mode PULL, `node-zklib`). Aucune configuration spéciale n'est requise sur le lecteur.
- **Hikvision** : le serveur interroge l'historique des événements via l'API ISAPI (authentification Digest). Vérifiez que le compte utilisateur déclaré dans `.env` a les droits d'accès à l'API sur le terminal.

Dans les deux cas, le **matricule** saisi lors de l'enrôlement biométrique de l'élève sur le lecteur doit être **identique** au champ `matricule` de la table `students`. C'est ce qui permet de relier un pointage physique à la bonne fiche élève.

Si un lecteur devient injoignable, il passe automatiquement `en_ligne = false` (table `devices`) et un incident est journalisé dans `device_incidents` — c'est ce qu'affiche l'écran "État des lecteurs" du dashboard.

## 9. Appel en classe (scan QR code)

1. Un badge QR est généré automatiquement pour chaque élève à sa création (`POST /api/students`).
2. Récupérez l'image à imprimer avec `GET /api/students/:id/badge`.
3. L'application tablette/smartphone de l'enseignant envoie chaque scan à `POST /api/attendance/qr-scan`.
4. En cas de badge perdu, recréez simplement le jeton (ré-appelez la génération) pour révoquer l'ancien badge.

## 10. Notifications aux parents

- Chaque pointage (ZKTeco, Hikvision, QR, ou saisie manuelle) programme automatiquement une notification "présence"/"retard" pour le(s) parent(s) rattaché(s).
- L'écran "Rattachement parents" utilise `POST /api/notifications/rapport` avec `mode: "immediat"` ou `mode: "differe"` + `date_envoi`.
- Un job toutes les minutes (`src/jobs/scheduler.js`) envoie tout ce qui est dû, via Expo Push ou Firebase Cloud Messaging selon `NOTIFICATION_PROVIDER`.
- Le `push_token` de chaque parent est enregistré depuis l'application mobile (à connecter côté app : `PATCH /api/parents/:id/push-token` — à ajouter selon votre besoin exact).

## 11. Espace Parent

Une page dédiée (`public/espace-parent.html`, accessible sur `/espace-parent.html`)
permet à un parent de se connecter avec son numéro de téléphone — un code à 6
chiffres lui est envoyé par SMS (réutilise la même intégration Orange que les
notifications de présence), sans mot de passe à retenir.

Une fois connecté, il retrouve tous ses enfants rattachés à ce numéro et peut
consulter, pour chacun : sa présence des 30 derniers jours, ses bulletins par
période, et le solde de sa scolarité — avec un paiement en ligne direct
(CinetPay) si un solde reste dû.

Aucune configuration supplémentaire n'est nécessaire — les mêmes variables
d'environnement que pour les notifications SMS et les paiements suffisent.

## 12. Prochaines étapes suggérées

- Connecter le frontend web (dashboard) et l'application mobile parents à cette API
- Ajouter l'authentification des enseignants sur l'appli tablette
- Générer les rapports PDF (registre journalier, bulletin mensuel) — un point d'extension existe dans `src/routes/notifications.js` et peut être complété avec une librairie comme `pdfkit`
- Ajouter les tests automatisés avant mise en production
