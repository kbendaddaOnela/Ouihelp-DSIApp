# DSI App — Document de spécifications

> Document de référence pour le développement avec Claude Code.  
> Dernière mise à jour : avril 2026

---

## 1. Contexte & objectif

**DSI App** est une application web interne destinée à l'équipe IT de **ONELA** (groupe Ouihelp). Elle centralise la gestion et l'administration du Système d'Information : création de comptes, inventaire matériel et applicatif, gestion des licences, budget/facturation, et ticketing interne.

### Contexte multi-tenant
- **Tenant actuel** : ONELA (Microsoft Entra ID / Azure AD)
- **Tenant cible** : Ouihelp (migration prévue sept/oct 2026)
- L'application doit être **tenant-agnostic** dès le départ : toutes les données sont liées à un identifiant utilisateur universel, indépendant du tenant Microsoft.

### Utilisateurs cibles
| Profil | Accès |
|---|---|
| Collaborateurs | Portail ticketing uniquement (`support.ouihelp.com`) |
| Équipe IT | Tous les modules sauf budget/facturation |
| Admin / DSI | Accès complet, incluant budget et facturation |

---

## 2. URLs & déploiement

| Environnement | URL | Usage |
|---|---|---|
| Production provisoire | `dsi.onela.com` | Pendant phase ONELA |
| Production définitive | `dsi.ouihelp.com` | Post-migration Ouihelp |
| Portail collaborateurs | `support.ouihelp.com` | Ticketing uniquement |
| Développement | `localhost:5173` | Local dev |

### Infrastructure
- **Frontend** : Azure Static Web Apps (tenant ONELA, migrable vers Ouihelp)
- **Backend / API** : Azure Container Apps ou Azure Functions
- **Base de données** : Supabase (PostgreSQL managé) — hébergé séparément, indépendant du tenant
- **Authentification** : Microsoft Entra ID (SSO unique, MSAL.js)
- **DNS** : Sous-domaines à créer dans la zone DNS Microsoft du tenant ONELA

---

## 3. Stack technique

### Frontend
- **Framework** : React 18 + TypeScript
- **Build** : Vite
- **UI** : Tailwind CSS + shadcn/ui
- **Routing** : React Router v6
- **State** : Zustand (global) + React Query (data fetching)
- **Auth client** : @azure/msal-react

### Backend
- **Runtime** : Node.js 20
- **Framework** : Hono (API REST légère et rapide)
- **ORM** : Drizzle ORM + PostgreSQL (Supabase)
- **Auth serveur** : Validation JWT Microsoft Entra ID

### Intégrations API externes
- **Microsoft Graph API** : Azure AD, Intune, licences M365
- **Google Admin SDK** : Workspace Ouihelp (comptes Google, groupes)
- **Slack API** : Création/désactivation de comptes Slack

### Outils de développement
- **Monorepo** : pnpm workspaces (`apps/web`, `apps/api`, `packages/shared`)
- **Linting** : ESLint + Prettier
- **Tests** : Vitest (unit) + Playwright (e2e)
- **CI/CD** : GitHub Actions

---

## 4. Architecture du projet

```
dsi-app/
├── apps/
│   ├── web/                  # Frontend React
│   │   ├── src/
│   │   │   ├── modules/      # Un dossier par module métier
│   │   │   │   ├── accounts/
│   │   │   │   ├── inventory/
│   │   │   │   ├── apps-inventory/
│   │   │   │   ├── licenses/
│   │   │   │   ├── budget/
│   │   │   │   └── ticketing/
│   │   │   ├── components/   # Composants partagés
│   │   │   ├── layouts/      # Shell, Sidebar, Header
│   │   │   ├── lib/          # auth, api client, utils
│   │   │   └── types/        # Types TypeScript partagés
│   └── api/                  # Backend Hono
│       ├── src/
│       │   ├── routes/       # Un fichier par module
│       │   ├── services/     # Logique métier + appels APIs externes
│       │   ├── db/           # Schéma Drizzle + migrations
│       │   └── middleware/   # Auth JWT, RBAC, logging
└── packages/
    └── shared/               # Types et utilitaires communs web+api
```

---

## 5. Authentification & rôles

### SSO Microsoft Entra ID
- Connexion via MSAL.js (flux Authorization Code + PKCE)
- Le token JWT Microsoft est validé côté API à chaque requête
- Pas de mot de passe stocké dans l'application

### Rôles applicatifs (stockés en base, pas dans Entra ID)
```typescript
type Role = 'admin' | 'it_team' | 'collaborator'
```

| Permission | collaborator | it_team | admin |
|---|---|---|---|
| Créer un ticket | ✅ | ✅ | ✅ |
| Voir ses tickets | ✅ | ✅ | ✅ |
| Gérer tous les tickets | ❌ | ✅ | ✅ |
| Création de comptes | ❌ | ✅ | ✅ |
| Inventaire matériel | ❌ | ✅ | ✅ |
| Inventaire applicatif | ❌ | ✅ | ✅ |
| Gestion des licences | ❌ | ✅ | ✅ |
| Budget / facturation | ❌ | ❌ | ✅ |
| Gestion des utilisateurs | ❌ | ❌ | ✅ |

---

## 6. Modules — spécifications détaillées

### 6.1 Module : Création de comptes

**Objectif** : Provisionner un nouvel utilisateur sur l'ensemble des outils du SI en une seule action.

**Champs du formulaire de création**
- Prénom, Nom
- Entité (liste : ONELA / Ouihelp / Autre)
- Service / département
- Manager (auto-complétion depuis Azure AD)
- Date d'arrivée
- Type de contrat (CDI, CDD, stage, alternance, prestataire)
- Outils à provisionner (cases à cocher) :
  - Azure AD / M365
  - Google Workspace
  - Slack
  - Autres (champ libre)

**Actions déclenchées automatiquement**
1. Création du compte Azure AD (Microsoft Graph API)
2. Attribution des licences M365 selon l'entité et le service
3. Ajout aux groupes Azure AD correspondants (entité + service)
4. Création du compte Google Workspace si coché (Google Admin SDK)
5. Invitation Slack si coché (Slack API)
6. Envoi d'un email de bienvenue avec les accès (Microsoft Graph - Send Mail)

**Historique** : chaque création est loggée en base (qui a créé, quand, quels outils).

---

### 6.2 Module : Inventaire matériel

**Objectif** : Vue complète du parc matériel, Intune et hors-Intune.

**Sources de données**
- **Intune** (Microsoft Graph API) : sync automatique quotidienne
- **Hors-Intune** : saisie manuelle avec formulaire dédié

**Données par device**
- Nom, type (PC, Mac, téléphone, tablette, autre)
- Numéro de série
- Marque / modèle
- Utilisateur assigné
- Entité / service
- Statut (en service, en stock, en réparation, hors service)
- Date d'achat, fin de garantie
- Source (Intune / Manuel)
- Notes libres

**Vues disponibles**
- Tableau filtrable/triable (par entité, type, statut, utilisateur)
- Vue par utilisateur (tous ses devices)
- Alertes : garanties expirant dans les 30/60/90 jours

**Actions**
- Modifier un device
- Assigner / désassigner un utilisateur
- Changer le statut
- Exporter en CSV

---

### 6.3 Module : Inventaire applicatif

**Objectif** : Cartographie visuelle et liste de toutes les applications utilisées.

**Données par application**
- Nom, logo/icône
- Catégorie (CRM, RH, Finance, Productivité, Infra, Sécurité, Métier...)
- Éditeur
- Type (SaaS, on-premise, interne)
- Tenant concerné (ONELA / Ouihelp / Les deux)
- Statut (actif, en cours de dépréciation, déprécié)
- Responsable IT
- URL d'accès
- Documentation / lien Confluence
- Nombre d'utilisateurs (si connu)
- Coût mensuel (optionnel, visible admin uniquement)
- Intégré SSO : oui/non

**Vues**
- Liste filtrée par catégorie / tenant / statut
- Schéma interactif (carte visuelle des applications groupées par catégorie, avec liens entre les apps intégrées)

---

### 6.4 Module : Gestion des licences

**Objectif** : Vision consolidée des licences M365 et autres, par entité et service.

**Sources**
- Microsoft Graph API (licences M365 : E3, E5, Business Premium, etc.)
- Saisie manuelle pour les autres éditeurs

**Vues**
- Tableau de bord : total licences / assignées / disponibles par produit
- Répartition par entité (ONELA / Ouihelp)
- Répartition par service
- Utilisateurs sans licence assignée
- Licences assignées à des comptes désactivés (à récupérer)

**Alertes**
- Licences épuisées (0 disponible)
- Licences sur-provisionnées (utilisateurs inactifs)

---

### 6.5 Module : Budget & Facturation

**Accès : admin / DSI uniquement**

**Objectif** : Suivi des dépenses IT par entité, service et fournisseur.

**Fonctionnalités**
- Saisie des lignes budgétaires (fournisseur, montant HT, récurrence, entité, service, catégorie)
- Vue annuelle avec comparaison budget prévu vs réalisé
- Répartition par entité et service
- Export PDF et CSV
- Historique des factures (upload PDF + métadonnées)

**Catégories de dépenses**
- Licences logicielles
- Matériel
- Hébergement / Cloud
- Téléphonie
- Prestataires
- Divers

---

### 6.6 Module : Ticketing

**Objectif** : Système de ticketing interne pour les collaborateurs, avec routage automatique vers la bonne équipe IT.

#### Portail collaborateur (`support.ouihelp.com`)
Interface simplifiée, accessible à tous les collaborateurs via SSO Microsoft.

**Formulaire de création de ticket — champs et ordre**

1. **Catégorie** (liste déroulante niveau 1)
   - Matériel
   - Accès & comptes
   - Logiciel & applications
   - Téléphonie
   - Réseau & connectivité
   - Autre

2. **Sous-catégorie** (liste déroulante niveau 2, dynamique selon catégorie)
   - Matériel → Panne, Périphérique, Nouveau matériel demandé, Autre
   - Accès & comptes → Réinitialisation mot de passe, Nouvel accès, Retrait accès, Blocage compte, Autre
   - Logiciel & applications → Bug, Installation, Mise à jour, Droits applicatifs, Autre
   - Téléphonie → Panne téléphone, Problème Teams/appels, SIM, Autre
   - Réseau → Pas de connexion, WiFi, VPN, Autre
   - Autre → Demande générale

3. **Impact** (liste déroulante)
   - Bloquant — je ne peux pas travailler
   - Gênant — je peux travailler mais avec difficulté
   - Mineur — quand vous avez le temps

4. **Titre** (champ texte court)

5. **Description** (champ texte long)

6. **Pièces jointes** (optionnel, max 5 fichiers, 10 Mo chacun)

#### Logique de routage automatique

```
Catégorie = "Matériel"                    → File : Core IT technique
Catégorie = "Réseau & connectivité"       → File : Core IT technique
Catégorie = "Téléphonie"                  → File : Core IT technique
Catégorie = "Accès & comptes"             → File : Core IT technique
Catégorie = "Logiciel & applications"     → File : Support applicatif
Catégorie = "Autre"                       → File : À qualifier (file commune)
```

#### Statuts des tickets
`Nouveau` → `En cours` → `En attente d'information` → `Résolu` → `Fermé`

#### Vue équipe IT (dans DSI App)
- Vue Kanban par file (Core IT / Support applicatif / À qualifier)
- Vue liste avec filtres (statut, priorité, assigné, entité)
- Prise en charge d'un ticket (assignation à soi-même ou à un membre)
- Commentaires internes (non visibles du collaborateur)
- Réponse au collaborateur (visible, avec notification email)
- Historique complet du ticket

#### Notifications
- Collaborateur : confirmation création ticket (email) + notification à chaque changement de statut
- Équipe IT : notification Slack (webhook) à chaque nouveau ticket dans leur file

---

## 7. Design & UI

- **Thème** : Clair par défaut, mode sombre supporté
- **Couleurs** : Palette à définir (suggestion : bleu principal #2563EB, accents selon entité)
- **Composants** : shadcn/ui (Button, Input, Select, Table, Dialog, Badge, Card...)
- **Sidebar** : Navigation principale avec icônes + labels, collapsible
- **Header** : Nom de l'app, breadcrumb, avatar utilisateur + déconnexion
- **Responsive** : Desktop prioritaire, tablette acceptable, mobile non requis pour l'app DSI (sauf portail ticketing collaborateur)

---

## 8. Plan de développement — phases

### Phase 1 — Fondations (sprint 1-2)
- [ ] Setup monorepo (pnpm + Vite + React + TypeScript)
- [ ] Authentification SSO Microsoft Entra ID (MSAL.js)
- [ ] Shell applicatif (layout, sidebar, routing, rôles)
- [ ] Base de données Supabase (schéma initial : users, roles, tickets, devices, apps)
- [ ] API backend Hono avec middleware auth JWT

### Phase 2 — Modules opérationnels (sprint 3-5)
- [ ] Module Création de comptes (Azure AD + M365)
- [ ] Module Inventaire matériel (Intune sync + saisie manuelle)
- [ ] Module Licences (Graph API)

### Phase 3 — Ticketing (sprint 6-7)
- [ ] Portail collaborateur (`support.ouihelp.com`)
- [ ] Formulaire ticket avec routage automatique
- [ ] Vue équipe IT (Kanban + liste)
- [ ] Notifications email + Slack webhook

### Phase 4 — Modules avancés (sprint 8-10)
- [ ] Inventaire applicatif + cartographie interactive
- [ ] Budget & Facturation (admin only)
- [ ] Dashboard DSI (KPIs globaux)

### Phase 5 — Migration tenant (sept/oct 2026)
- [ ] Mise à jour config Entra ID (nouveau tenant Ouihelp)
- [ ] Migration DNS vers `dsi.ouihelp.com` et `support.ouihelp.com`
- [ ] Tests de non-régression complets

---

## 9. Variables d'environnement requises

```env
# Microsoft Entra ID
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
AZURE_TENANT_ID=
AZURE_AUTHORITY=https://login.microsoftonline.com/{TENANT_ID}

# Microsoft Graph
GRAPH_SCOPE=https://graph.microsoft.com/.default

# Google Workspace
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_SERVICE_ACCOUNT_KEY=
GOOGLE_WORKSPACE_DOMAIN=

# Slack
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_WEBHOOK_URL_CORE_IT=
SLACK_WEBHOOK_URL_SUPPORT_APP=

# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
DATABASE_URL=

# App
APP_URL=http://localhost:5173
API_URL=http://localhost:3000
NODE_ENV=development
```

---

## 10. Instructions pour Claude Code

Quand tu travailles sur ce projet, respecte ces conventions :

1. **Toujours TypeScript strict** — pas de `any`, pas de `as unknown`
2. **Composants React** — fonction arrow + export named, pas de default export sauf pour les pages
3. **API calls** — toujours via le client centralisé dans `lib/api.ts`, jamais de fetch direct dans les composants
4. **Gestion d'erreurs** — toujours gérer les erreurs API, afficher un toast utilisateur
5. **RBAC** — vérifier le rôle côté API (middleware) ET côté frontend (hook `usePermission`)
6. **Commentaires** — en français pour la logique métier, en anglais pour le code technique
7. **Commits** — format conventionnel : `feat:`, `fix:`, `chore:`, `docs:`
8. **Secrets** — jamais de credential en dur, toujours via variables d'environnement
9. **Tenant-agnostic** — ne jamais hardcoder un tenant ID, toujours via config/env

---

*Ce document est vivant — il sera mis à jour à chaque nouvelle phase de développement.*
