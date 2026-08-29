-- ============================================================================
-- Schéma de base de données — Cahier d'Appel numérique
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- pour gen_random_uuid()

-- --------------------------------------------------------------------------
-- Utilisateurs de l'application (Direction, Enseignant, Surveillant général)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  mot_de_passe_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('direction', 'enseignant', 'surveillant')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Classes
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom TEXT NOT NULL UNIQUE,
  annee_scolaire TEXT NOT NULL DEFAULT to_char(now(), 'YYYY') || '-' || to_char(now() + interval '1 year', 'YYYY'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rattachement enseignant <-> classe (un enseignant peut avoir plusieurs classes)
CREATE TABLE IF NOT EXISTS enseignant_classes (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  classe_id UUID REFERENCES classes(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, classe_id)
);

-- --------------------------------------------------------------------------
-- Parents / tuteurs
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom TEXT NOT NULL,
  telephone TEXT NOT NULL,
  email TEXT,
  push_token TEXT, -- jeton de notification de l'appli mobile (Expo/FCM)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Élèves
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  matricule TEXT UNIQUE NOT NULL, -- identifiant utilisé pour lier au lecteur biométrique (ZKTeco/Hikvision) et au QR code
  nom TEXT NOT NULL,
  classe_id UUID REFERENCES classes(id) ON DELETE SET NULL,
  methode_biometrique TEXT CHECK (methode_biometrique IN ('empreinte', 'visage', 'aucune')) DEFAULT 'aucune',
  qr_token TEXT UNIQUE, -- jeton signé encodé dans le QR code du badge
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rattachement élève <-> parent(s) — plusieurs parents possibles par élève
CREATE TABLE IF NOT EXISTS student_parents (
  student_id UUID REFERENCES students(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES parents(id) ON DELETE CASCADE,
  lien TEXT DEFAULT 'parent', -- parent, tuteur, etc.
  PRIMARY KEY (student_id, parent_id)
);

-- --------------------------------------------------------------------------
-- Lecteurs biométriques déclarés (ZKTeco / Hikvision) — entrée établissement
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom TEXT NOT NULL,
  marque TEXT NOT NULL CHECK (marque IN ('zkteco', 'hikvision')),
  adresse_ip TEXT NOT NULL,
  emplacement TEXT, -- ex. "Portail Nord"
  en_ligne BOOLEAN NOT NULL DEFAULT true,
  derniere_synchro TIMESTAMPTZ
);

-- Historique des incidents de connexion des lecteurs
CREATE TABLE IF NOT EXISTS device_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('deconnecte', 'reconnecte')),
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Emploi du temps (créneaux par classe)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS creneaux (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  classe_id UUID REFERENCES classes(id) ON DELETE CASCADE,
  jour_semaine SMALLINT NOT NULL CHECK (jour_semaine BETWEEN 1 AND 7), -- 1 = lundi
  heure_debut TIME NOT NULL,
  heure_fin TIME NOT NULL,
  matiere TEXT NOT NULL,
  enseignant TEXT
);

-- Calendrier scolaire (jours fériés / vacances) — exclus du calcul d'absences
CREATE TABLE IF NOT EXISTS jours_non_scolaires (
  date DATE PRIMARY KEY,
  libelle TEXT
);

-- --------------------------------------------------------------------------
-- Pointages (source unique, alimentée par ZKTeco, Hikvision, scan QR ou saisie manuelle)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID REFERENCES students(id) ON DELETE CASCADE,
  creneau_id UUID REFERENCES creneaux(id) ON DELETE SET NULL, -- NULL si pointage global entrée établissement
  source TEXT NOT NULL CHECK (source IN ('zkteco', 'hikvision', 'qr', 'manuel')),
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  statut TEXT NOT NULL CHECK (statut IN ('present', 'retard', 'absent')),
  horodatage TIMESTAMPTZ NOT NULL DEFAULT now(),
  saisi_par UUID REFERENCES users(id), -- rempli si source = 'manuel'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance_events (student_id, horodatage);
CREATE INDEX IF NOT EXISTS idx_attendance_creneau ON attendance_events (creneau_id);

-- --------------------------------------------------------------------------
-- Justificatifs d'absence/retard
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS justificatifs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID REFERENCES students(id) ON DELETE CASCADE,
  motif TEXT NOT NULL,
  document_url TEXT,
  statut TEXT NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente', 'valide', 'refuse')),
  depose_par UUID REFERENCES parents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Notifications envoyées aux parents (journal + planification différée)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID REFERENCES students(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES parents(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('presence', 'retard', 'absence', 'rapport_journalier', 'rapport_mensuel', 'info')),
  contenu TEXT NOT NULL,
  statut TEXT NOT NULL DEFAULT 'programmee' CHECK (statut IN ('programmee', 'envoyee', 'echouee')),
  envoyer_a TIMESTAMPTZ NOT NULL DEFAULT now(), -- immédiat = now(), différé = date/heure choisie
  envoyee_a TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_envoyer_a ON notifications (statut, envoyer_a);

-- --------------------------------------------------------------------------
-- Ajout du niveau scolaire sur les classes (ex. "CM2", "6ème") — permet de
-- regrouper les classes A/B/C d'un même niveau dans l'interface.
-- ALTER ... IF NOT EXISTS : sans danger à rejouer sur une base déjà migrée.
-- --------------------------------------------------------------------------
ALTER TABLE classes ADD COLUMN IF NOT EXISTS niveau TEXT;

-- --------------------------------------------------------------------------
-- Matières enseignées par un enseignant (liste libre séparée par des virgules)
-- --------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS matieres TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS statut_emploi TEXT CHECK (statut_emploi IN ('permanent', 'vacataire') OR statut_emploi IS NULL);
ALTER TABLE students ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- --------------------------------------------------------------------------
-- Créneaux exceptionnels (heures de rattrapage) : un créneau normal se répète
-- chaque semaine (jour_semaine renseigné) ; un créneau de rattrapage n'a lieu
-- qu'une seule fois, à une date précise (date_exceptionnelle renseignée à la
-- place). Un créneau de rattrapage compte comme "travaillé" même un jour férié.
-- --------------------------------------------------------------------------
ALTER TABLE creneaux ALTER COLUMN jour_semaine DROP NOT NULL;
ALTER TABLE creneaux ADD COLUMN IF NOT EXISTS date_exceptionnelle DATE;
ALTER TABLE creneaux DROP CONSTRAINT IF EXISTS creneaux_un_type_requis;
ALTER TABLE creneaux ADD CONSTRAINT creneaux_un_type_requis
  CHECK (jour_semaine IS NOT NULL OR date_exceptionnelle IS NOT NULL);

-- --------------------------------------------------------------------------
-- Clé secrète par école, utilisée par le petit programme "agent" local
-- (installé sur un PC de l'école) pour transmettre au serveur central les
-- pointages ZKTeco/Hikvision — sans avoir besoin d'un compte utilisateur.
-- --------------------------------------------------------------------------
ALTER TABLE ecoles ADD COLUMN IF NOT EXISTS cle_agent TEXT UNIQUE;

-- --------------------------------------------------------------------------
-- Horaires de démarrage des cours, propres à chaque école — utilisés par
-- la génération automatique de l'emploi du temps (au lieu d'horaires fixes).
-- --------------------------------------------------------------------------
ALTER TABLE ecoles ADD COLUMN IF NOT EXISTS heure_debut_matin TIME DEFAULT '07:30';
ALTER TABLE ecoles ADD COLUMN IF NOT EXISTS heure_fin_matin TIME DEFAULT '12:30';
ALTER TABLE ecoles ADD COLUMN IF NOT EXISTS heure_debut_apresmidi TIME DEFAULT '13:00';
ALTER TABLE ecoles ADD COLUMN IF NOT EXISTS heure_fin_apresmidi TIME DEFAULT '18:00';

-- --------------------------------------------------------------------------
-- Matières prédéfinies par école — évite de retaper le nom d'une matière à
-- chaque fois ; les enseignants choisissent dans cette liste au lieu de taper.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS matieres (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom TEXT NOT NULL,
  ecole_id UUID REFERENCES ecoles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nom, ecole_id)
);

-- --------------------------------------------------------------------------
-- Écoles — profil du/des établissement(s) utilisant l'application.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ecoles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom TEXT NOT NULL,
  adresse TEXT,
  ville TEXT,
  telephone TEXT,
  annee_scolaire TEXT,
  active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Rattachement à une école — permet de gérer plusieurs écoles indépendamment.
-- ecole_id = NULL sur un compte utilisateur signifie "accès à toutes les
-- écoles" (compte de direction générale / groupe scolaire) ; sur une classe
-- ou un lecteur, NULL veut dire "pas encore rattaché à une école".
-- --------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS ecole_id UUID REFERENCES ecoles(id);
ALTER TABLE classes ADD COLUMN IF NOT EXISTS ecole_id UUID REFERENCES ecoles(id);
ALTER TABLE classes ADD COLUMN IF NOT EXISTS vacation TEXT CHECK (vacation IN ('matin', 'apres_midi') OR vacation IS NULL);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS ecole_id UUID REFERENCES ecoles(id);

-- --------------------------------------------------------------------------
-- Rôle "super_admin" : réservé au développeur/propriétaire du système.
-- C'est le SEUL rôle qui voit et gère l'ensemble des écoles. Un compte
-- "direction" doit toujours être rattaché à une école précise (ecole_id NOT NULL
-- appliqué au niveau applicatif, pas en base, pour rester souple à la migration).
-- --------------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin', 'direction', 'enseignant', 'surveillant'));
