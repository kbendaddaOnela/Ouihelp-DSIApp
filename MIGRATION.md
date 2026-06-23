# DSI App ONELA — Module Migration M365 → Google Workspace

> Documentation de référence du module de migration.
> Dernière mise à jour : **22/06/2026**.

---

## 1. Contexte & objectif

Application interne ONELA pilotant la migration **Microsoft 365 (tenant ONELA)** → **Google Workspace (tenant GOH)** des utilisateurs et boîtes mail partagées.

- **Stack** : monorepo pnpm — `apps/api` (Hono + Drizzle/MySQL), `apps/web` (React + TanStack Query + Tailwind).
- **Auth** : Entra ID (MSAL).
- **Hébergement** : Azure App Service (API conteneurisée) + Azure Static Web Apps (front).
- **Période de migration** : mai → novembre 2026, par lots, pilotée par la DSI.
- **Particularité** : le tenant source M365 reste actif pendant la transition (dual-delivery via redirection Exchange) → orchestration utilisateur par utilisateur, avec reprise, pause et suivi d'erreurs.

---

## 2. Modules de l'application

| Module | Rôle |
|---|---|
| **migration** | Migration d'un utilisateur : mail + calendrier + contacts + alias + send-as + OU + redirection Exchange. Le plus gros et le plus critique. |
| **shared-mailbox** | Boîtes partagées Exchange → Google Groups / Gmail-label-as-shared-mailbox. Worker indépendant. |
| **migration-targets** | Import CSV de la cible totale (dashboard de suivi global par département/site). |
| **inventory** | Cache Entra (users + devices), sync incrémentale. |
| **budget** | Suivi des coûts (entité de facturation, quantité, coût unitaire). |
| **onela-contacts** | Annuaire ONELA partagé poussé dans les Google Contacts de chaque user (People API). |

---

## 3. Étapes de migration d'un utilisateur (séquence opérationnelle 1→8)

La carte de migration présente les étapes dans l'ordre d'exécution :

1. **Migration mail** — import MIME Exchange → Gmail (le plus long).
2. **Alias Google** — ajout de l'alias `prenom.nom@onela.com`.
3. **Nouveau format** — alias + send-as + définition par défaut.
4. **OU onela.com** — déplacement dans l'OU Google de destination.
5. **Redirection Exchange** — dual-delivery (ForwardingSmtpAddress).
6. **Migration calendrier** — events Exchange → Google Calendar.
7. **Migration contacts** — contacts personnels Exchange → Google Contacts.
8. **Intégration contacts ONELA** — annuaire partagé poussé dans les Google Contacts (libellé unique « ONELA »).

---

## 4. Stratégie opérationnelle (version stabilisée — juin 2026)

Apprise après un raté sur Marketing/Formation : si la migration tourne sur la fenêtre vendredi→lundi pendant que l'utilisateur continue à traiter ses mails dans Outlook, l'état figé côté Gmail diverge (mails non lus/non classés côté Gmail alors que traités côté Outlook).

**Procédure à partir du lot RH :**

1. **Vendredi 18h** — lancer la migration de **2 utilisateurs max** (limite worker `MAX_CONCURRENT_MAIL=2`).
2. **Activer immédiatement** : alias Google + send-as + redirection Exchange (dual-delivery actif tout de suite).
3. **Attendre ~10 000 mails migrés** → mettre en pause.
4. **Lancer les 2 suivants** (idem alias + dual-delivery immédiat).
5. **Lundi 9h30** : chaque user a au moins ses 10k mails récents + tout ce qui est arrivé via dual-delivery depuis vendredi.
6. **En semaine** : rattrapage des mails historiques en arrière-plan (peu critique).

> ⚠️ **Communiquer aux users** : ne pas traiter leurs mails dans Outlook entre vendredi 18h et lundi 9h30 (cutover). Le drift one-way Outlook→Gmail est intrinsèque, non contournable sans sync bidirectionnel (hors scope).

---

## 5. Planning des lots

| Phase | Lot | Personnes | Date | Statut |
|---|---|---|---|---|
| 1 | Khalid (DSI) | 1 | 13/05 | ✅ Terminé |
| 1 | Lucianne | 1 | 19/05 | ✅ Terminé |
| 1 | Équipe DSI | 3 | 25/05 | ✅ Terminé |
| 2 | Marketing & Formation | 5 | 04/06 | ✅ Terminé |
| 3 | RH | 15 | 15/06 | ✅ Terminé |
| 3 | Finance · Compta | 6 | 22/06 | ✅ Terminé |
| 3 | Finance · ADV | 12 | 29/06 | À venir |
| 3 | Finance · CDG | 2 | 29/06 | À venir |
| 3 | Réseaux · Service clients · DR | 11 | 06/07 | À venir |
| 3 | Qualité | 3 | 06/07 | À venir |
| 4 | SRR | variable | 12/09 | — |
| 4 | Agences pilote Hassibot (Fontainebleau, Champs-sur-Marne, Saint-Maur) | variable | 21/09 | — |
| 5 | IDF EST | variable | 05/10 | — |
| 5 | IDF OUEST | variable | 12/10 | — |
| 5 | NORD NORMANDIE | variable | 19/10 | — |
| 5 | RHÔNE ALPES | variable | 26/10 | — |
| 5 | OUEST SUD OUEST | variable | 02/11 | — |
| 5 | SUD EST | variable | 09/11 | — |

---

## 6. Architecture & décisions de design non-évidentes

### 6.1 Worker in-process (polling 5 s)

- `MAX_CONCURRENT = 6` (toutes phases) · `MAX_CONCURRENT_MAIL = 2` · `MAIL_CONCURRENCY = 2` (messages parallèles par job).
- **Pourquoi ces limites basses** : l'endpoint Graph `messages/{id}/$value` (download MIME) est le plus throttlé de toute l'API. À 2 jobs × 2 msg/s on est déjà proche du plafond app-wide. Monter plus haut **réduit** le débit (cascades de 429 → throttle adaptatif jusqu'à 8s → tout le monde attend).
- **Ne pas augmenter ces constantes sans tester.**
- Le worker ne démarre **qu'en `NODE_ENV=production`** (`apps/api/src/index.ts`). En dev, la file n'est jamais traitée (volontaire).

### 6.2 Idempotence (reprise sans doublon)

- Table `migrated_messages` : une ligne par message migré (`graphMessageId` unique par migration).
- Au resume : chargement du `skipSet` (IDs déjà en success/skipped), l'itération re-parcourt tout et **skippe** les déjà-migrés.
- **Dedup secondaire par Message-ID** (`gmailFindByMessageId`) : si un mail a été déposé par le dual-delivery pendant une pause, il est détecté comme doublon et marqué success sans réimport.
- ⚠️ Ne **jamais** supprimer `migrated_messages` hors du bouton « Réinitialiser » explicite — c'est la mémoire de reprise.

### 6.3 Sémantique de la pause

- « Mettre en pause » **ne pose pas** `mailLastSyncAt`.
- **Pourquoi** : si `lastSyncAt` était posé à la pause, la relance deviendrait un delta « depuis l'heure de pause » qui zapperait tous les mails plus anciens jamais migrés → backfill historique impossible.
- Complétion **naturelle** : `lastSyncAt = syncStartedAt` → la relance manuelle suivante est un vrai delta.

### 6.4 Borne supérieure `syncStartedAt`

- Capturée avant le pré-comptage, passée comme `until` à `iterateOnelaMessages` / `countOnelaMessages` (filtre `receivedDateTime <= syncStartedAt`).
- **Pourquoi** : sans ça, l'itérateur attrape les mails arrivés via dual-delivery **pendant** le run, les compte comme « dédup », et le compteur monte sans fin (illusion d'un 100% jamais atteint).
- Ces mails sont couverts par la **synchro delta suivante** — pas perdus.

### 6.5 ⚠️ Signet de reprise — TENTÉ puis REVERTÉ (ne pas re-tenter)

- Idée : borner l'itérateur sous le plus ancien mail migré pour éviter le re-parcours.
- **Pourquoi ça a cassé** : supposait que les mails migrés forment un bloc **contigu** par `receivedDateTime`. **Faux** — Graph `/messages` n'est pas garanti trié, et les runs interrompus laissent un set non-contigu. Cas réel (Esther SIOBA) : migration marquée « terminée » à tort à 23079/64663 (36%), 41584 mails abandonnés silencieusement.
- **État actuel** : re-parcours complet **insensible à l'ordre** (skipSet). Le « no-sleep-on-skip » garde ça rapide (~40s pour repaginer les métadonnées).
- **Endpoint de réparation** : `POST /migration/:id/resume-full` → efface `mailLastSyncAt` (re-parcours complet, pas un delta) + repasse en pending, **sans** supprimer `migrated_messages`. Bouton UI « Reprise complète » sur la carte (mail). Sert à réparer une migration faussement « terminée ».

### 6.6 `/run` en mode asynchrone (202)

- Insère tous les records en `pending`, retourne **202**, puis traite Entra (create + setAttributes + groupMembership) en background **par étape**.
- **Pourquoi** : évite le timeout HTTP Azure (~230s) sur gros lots ; isole l'échec d'une étape.
- Idempotency : refuse un `/run` si une migration non-archivée existe déjà pour le même `onelaUserId`.
- Compagnon : `POST /:id/retry-provisioning` (re-joue uniquement les steps non-success).

### 6.7 Hiérarchie des labels Gmail

- **Pass 1** : 5 fetches parallèles `/mailFolders/{wellKnownAlias}` (inbox/sent/drafts/junk/archive). `deleteditems` **exclu** (Corbeille Outlook non migrée).
- **Pass 2** : fallback **par displayName** (`'boîte de réception'` → `inbox`) si pass 1 échoue (throttling Graph).
- **Pass 3** : crawl récursif ; `WELL_KNOWN_CHILD_CONFIG` décide du préfixe enfant (racine pour inbox/archive, préfixé pour sentitems).
- **Label-strip retry** : sur « Invalid label: Label_XX », retire le label fautif et retente (max 10 strips/msg, fallback `['INBOX']`). Évite la perte de message.
- Bouton « Re-labelliser » (`/relabel-mail`) corrige les labels d'une migration finie sans re-télécharger.

### 6.8 Calendrier

- **Timezone** : header `Prefer: outlook.timezone="Europe/Paris"` sur les calls Graph + `timeZone: "Europe/Paris"` côté Google. Corrige le décalage d'1h sur les récurrents (DST cassé par stockage UTC).
- **Mapping identité source→cible** : `events.import` Google exige que le propriétaire du calendrier (`@mig.onela.com`) soit organisateur **ou** participant. `buildGoogleEvent` remappe l'organizer ET la ligne participant de l'utilisateur (`@onela.com` → `@mig.onela.com`), + filet de sécurité (ajoute le owner comme participant accepté si besoin). Sans ça : erreur `participantIsNeitherOrganizerNorAttendee` (400) sur tous les events que l'user a organisés.
- **Organizer d'origine préservé** pour les réunions où l'user était juste invité (sinon ses modifs/suppressions se propageraient à tous les participants).
- **Visibilité & couleur (demande compta)** :
  - Rdv déjà privés dans Outlook (`sensitivity` private/confidential) → restent **privés**.
  - Rdv **passés** non récurrents → forcés en **privé** à la migration (séries récurrentes laissées telles quelles).
  - Tout rdv privé reçoit la couleur **Sauge/vert `#33B679`** (`colorId 2`) pour ressortir.
  - La politique Groupe « tout public » reste le défaut ; seuls les privés/passés sont touchés.
- **Non faisable depuis l'app** : recolorer automatiquement un rdv quand un user le passe en privé *après* migration → nécessiterait un Google Apps Script domaine (watch Calendar + trigger). Les réglages d'UI Calendar (1er jour de semaine, format 24h, vue par défaut) sont en **lecture seule** via l'API — seul levier indirect : langue/région du compte = France.

### 6.9 Retry des erreurs mail

- `POST /:id/retry-errors/mail` : fast-lane qui reprend les messages en error d'un compte sans relancer toute la migration. Refait `fetchMime` + import direct vers `['INBOX']` (skip la résolution de labels, souvent la cause d'origine).
- **Pourquoi** : en delta sync, les erreurs ne sont jamais retentées (leur `receivedDateTime` < `lastSyncAt`).
- Bouton ambre « Réessayer les erreurs (vers INBOX) » quand `mailFailed > 0` et migration pas en cours.

### 6.10 Annuaire ONELA partagé (étape 8)

- Import CSV (`POST /onela-contacts/import`, séparateur `;`), normalisation des numéros FR en `+33`, dédup par email.
- Exclusion des comptes techniques/test (noreply, smtp-*, automate_mft, comptes de test/service…).
- `pushContactsToUser` : crée le groupe de contacts « ONELA », liste les emails existants (idempotence), exclut l'utilisateur lui-même, `batchCreateContacts` par lots de 200.

---

## 7. Points fragiles connus

### 7.1 Le worker peut hang OU être tué par un redéploiement

- **Symptôme** : aucun log worker dans Azure, ligne en `step_*_migration='running'`, bouton Pause sans effet (`signalStop` est une variable in-memory que le worker mort/nouveau ne lit pas).
- Détecteur d'orphelins : `ORPHAN_STALE_MS = 15 min` (heartbeat 60s repousse `updatedAt`).
- **Endpoint de secours** : `POST /api/migration/:id/unstick/:phase` force la phase en `error` sans toucher au tracking → « Reprendre » repart du point d'arrêt.
- > ⚠️ **Tout redéploiement = redémarrage du conteneur = tue tous les bg jobs** (worker mail ET jobs one-shot type retry/dedup/relabel). **Ne jamais redéployer pendant qu'une migration tourne.**

Recette unstick depuis la console du navigateur :
```js
const account = (await window.msalInstance?.getAllAccounts?.())?.[0]
const t = await window.msalInstance.acquireTokenSilent({ ...window.apiLoginRequest, account })
await fetch('/api/migration/<MIGRATION_ID>/unstick/mail', {
  method: 'POST', headers: { Authorization: `Bearer ${t.accessToken}` }
}).then(r => r.json())
```

### 7.2 Throttling Microsoft Graph (tenant ONELA)

- `Mail.Read` app-only sur 53k+ mailboxes : ~4-6 req/s sur `$value`.
- Throttle adaptatif local par job (`batchDelay` 500ms→8s), **non coordonné entre jobs**.
- Lancer mail + cal + contacts × N users simultanément → cascades de 429 attendues.

### 7.3 Étapes 4 et 5 dépendent du SCIM sync

- L'alias Google et le déplacement d'OU ne marchent qu'**après** provisioning SCIM Entra → Google (5-40 min après création Entra).
- `GET /:id/check-google` interroge l'Admin SDK pour le savoir.
- Si « alias échoué après création » → attendre 5-40 min et réessayer.

---

## 8. Constantes opérationnelles

| Élément | Valeur |
|---|---|
| UPN GOH généré | `prenom.nom@mig.onela.com` (normalisation NFD + suppression non-`[a-z]`) |
| Domaine transition shared mailbox | `mig.<domaine_original>` (`TRANSITION_DOMAIN_PREFIX`) |
| Nouveau format alias | `prenom.nom@onela.com` |
| OU Google destination | `GOOGLE_ONELA_OU_PATH` (défaut `/onela.com`) |
| Timezone | `Europe/Paris` (tous les users ONELA) |
| Tenant ONELA | `ONELA_TENANT_ID` / `ONELA_CLIENT_ID` / `ONELA_CLIENT_SECRET` |
| Tenant GOH | `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` |
| Google SA (DwD) | `GOOGLE_SA_EMAIL` / `GOOGLE_SA_PRIVATE_KEY` / `GOOGLE_ADMIN_EMAIL` |

---

## 9. Endpoints utiles pour l'exploitation

| Endpoint | Usage |
|---|---|
| `POST /migration/:id/unstick/:phase` | Débloquer un worker hung sans perdre le tracking |
| `POST /migration/:id/resume-full` | Re-parcours complet (répare une migration faussement « terminée ») |
| `POST /migration/:id/retry-errors/mail` | Reprendre les mails en error vers INBOX |
| `POST /migration/:id/relabel-mail` | Corriger les labels d'une migration finie sans re-télécharger |
| `POST /migration/:id/dedupe-mail` | Purger les doublons par Message-ID dans Gmail |
| `POST /migration/:id/reset/:phase` | ⚠️ Destructif — efface `migrated_messages`, repart de 0 |
| `POST /migration/:id/retry-provisioning` | Re-joue les steps Entra non-success |
| `GET /migration/:id/errors/:phase/download` | CSV des erreurs |

---

## 10. Services externes utilisés

- **Microsoft Graph** (v1.0) : users, mailFolders, messages, calendar, contacts.
- **Exchange Online Admin REST** (`outlook.office365.com/adminapi/beta/{tid}`) : ForwardingSmtpAddress + InvokeCommand (Transport Rules).
- **Google Admin SDK Directory API** : users, aliases, groups, OU.
- **Google Groups Settings API** : `whoCanPostMessage`, `enableCollaborativeInbox`.
- **Google Groups Migration API** : import MIME historique vers groupes.
- **Gmail API** (DwD) : labels, filters, sendAs, messages.import/insert, batchModify.
- **Google People API** : contacts.
- **Google Calendar API** : events.

---

## 11. Particularités UI à connaître

- **Dashboard triable** : en-têtes de colonnes cliquables (Total / Terminés / En cours), tri par défaut sur Terminés.
- **Override cosmétique** (`MigrationDashboard.tsx`) : `DONE_OVERRIDES = { dsi: 5, formation: 3 }` affiche DSI 5/5 et Formation 3/3 comme terminés côté UI — **purement frontend, pas en DB** (tracking historique incomplet).
