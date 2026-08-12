# DSI App ONELA — Module Migration M365 → Google Workspace

> Documentation de référence du module de migration.
> Dernière mise à jour : **26/06/2026**.

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
| **sharepoint-migration** | Bibliothèques de sites SharePoint ONELA → Google Shared Drives (Drives partagés). Worker indépendant, transfert arborescent avec dates + « modifié par » préservés. Voir §12. |
| **accounts** | Création de comptes (onboarding nouvel arrivant) : GOH → MailContact routage ONELA léger → finalize Google auto (OU `/onela.com` + alias). Voir §13. |

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

---

## 12. Module `sharepoint-migration` (SharePoint → Google Shared Drives)

Ajouté le **23/06/2026**. Transfère une **bibliothèque** (ou un sous-dossier) d'un site SharePoint ONELA vers un **Google Shared Drive** (Drive partagé) du Workspace OUIHELP/GOH. Module **indépendant** de la migration utilisateur, calqué sur `shared-mailbox` (worker in-process, polling 5 s, heartbeat 60 s, détection d'orphelins 15 min, pause/unstick).

> ⚠️ Le tenant Google cible côté Workspace est **OUIHELP** (admin `…@ouihelp.fr`) ; les comptes des users migrés y sont en `prenom.nom@mig.onela.com`.

### 12.1 Flux opérateur (UI `/sharepoint-migration`)

1. **URL du site** (pré-remplie : `https://onelaservices.sharepoint.com/sites/ALL-ONELA/`) → **Résoudre** (Graph renvoie le site + ses bibliothèques).
2. **Choisir la bibliothèque** (Documents, DSI, FINANCE, RH…).
3. **Cocher un ou plusieurs dossiers** à migrer (cases à cocher ; clic sur le nom = naviguer dedans). Chaque dossier coché est **recréé à la racine du Shared Drive** (avec son nom, contenu à l'intérieur). **Ne rien cocher = toute la bibliothèque** (contenu à la racine, sans wrapper). Stocké en JSON dans `selected_roots`.
3bis. **Rechercher le Shared Drive cible** par nom — il doit être **créé manuellement** au préalable dans Google Drive ; l'app ne fait que le retrouver et le sélectionner.
4. Case **« Migrer l'historique des versions »** (défaut activé ; décocher = seule la version courante, plus rapide). **Créer** → **Lancer** sur la carte déclenche le worker.

### 12.2 Prérequis d'exploitation (sinon erreurs à l'exécution)

- **App ONELA (Graph, app-only)** : permissions `Sites.Read.All` + `Files.Read.All`.
- **Service Account Google (DwD)** : scope `https://www.googleapis.com/auth/drive` autorisé dans l'Admin Console.
- **API Google Drive activée** dans le projet GCP du Service Account (projet `865836154153`) — sinon `403 « Drive API has not been used / is disabled »`.

### 12.3 Schéma DB (idempotent, créé via `ensureSchemaPatches`)

- `sharepoint_migrations` : 1 ligne par migration (site, drive, sous-dossier, Shared Drive cible, statut `pending|running|paused|success|error`, compteurs fichiers/octets).
- `sharepoint_migrated_items` : 1 ligne par item (fichier **et** dossier), `sp_item_id` unique par migration = **clé d'idempotence/reprise**. Pour un dossier success, `gd_file_id` = l'id du dossier Google (réutilisé comme parent au resume, pas de doublon).

> Les 2 tables ont été ajoutées au pattern idempotent `ensureSchemaPatches` (gardé par `tableExists`), **pas** via une migration drizzle versionnée (le dossier `drizzle/` est désynchronisé du schéma — l'app évolue par patches). Aucune table existante n'est touchée.

### 12.4 Worker — parcours et reprise

- **Pré-comptage** d'abord : BFS métadonnées (sans téléchargement) → fixe `total_items` + `total_bytes` **avant** d'écrire `migrated_items` (sinon la barre saute à ~100 %, surtout au resume). Émet aussi un **diagnostic d'attribution** dans les logs (voir §12.6).
- **Transfert** ensuite : BFS **dossiers d'abord** (créés/réutilisés) puis fichiers (3 en parallèle). Le BFS garantit que le dossier parent Google existe avant ses enfants.
- **Idempotence** : `skipSet` sur `sp_item_id` des fichiers en success ; dossiers success réutilisés via leur `gd_file_id`. Les fichiers en error sont **re-tentés** au resume.
- **Single-instance** (une migration à la fois) ; pause = `signalStopSharepoint` (vérifié entre dossiers/batches).

### 12.5 ⚠️ Pièges techniques résolus (NE PAS réintroduire)

- **Téléchargement** : `@microsoft.graph.downloadUrl` est une *annotation d'instance* que Graph **retire dès qu'un `$select` est présent**. → passer par l'endpoint **`/content`** (302 vers une URL pré-authentifiée, suivie par `fetch` ; undici ne propage pas `Authorization` cross-origin, voulu).
- **Lecture du corps** : lire via **`res.arrayBuffer()`** sur la réponse Graph. **Jamais** `new Response(res.body).arrayBuffer()` → `« Response body object should not be disturbed or locked »` sur quasi tous les fichiers. L'upload Google se fait avec un **Buffer** (rejouable par undici), pas un flux.
- **Gros fichiers** : garde-fou `MAX_FILE_BYTES = 300 Mo` → fichier **ignoré** (`skipped_items`, statut d'item `skipped`, **pas** une erreur) avec mention « à transférer manuellement » (évite l'OOM — on bufferise ×3 en parallèle — et les timeouts de 10 min type backup `.pst`). La migration finit en `success` s'il n'y a **aucun vrai échec** ; la carte sépare erreurs (rouge) et ignorés (ambre).

### 12.6 Métadonnées préservées (comme BitTitan)

- **Dates** : `createdTime` + `modifiedTime` posés à la création + **PATCH `modifiedTime` de sécurité** après upload (au cas où la finalisation du contenu le repousse à « maintenant »). → la colonne « Date de modification » de Drive reflète la vraie date SharePoint.
- **« Modifié par » fidèle** = upload **en usurpant l'auteur** (impersonation DwD du compte `prenom.nom@mig.onela.com`), **pas** une métadonnée (on ne peut pas falsifier l'acteur dans un Shared Drive). Mécanique par fichier :
  1. résoudre l'auteur → compte Google via la table `migrations` : **email** (`onelaEmail`/`onelaUpn`) **puis nom** (`onelaDisplayName`). Le fallback par nom est **indispensable** : Graph omet souvent l'email dans `lastModifiedBy`/`createdBy` et ne laisse que le displayName ;
  2. ajouter l'auteur comme **membre temporaire** (writer) du Shared Drive (obligatoire pour y écrire en tant que lui) ;
  3. uploader en l'usurpant ;
  4. en **fin de run**, retirer les membres ajoutés (l'attribution « modifié par » **persiste** après le retrait).
- **Repli admin** (le fichier passe, « modifié par » = compte de migration) si : auteur non mappé, « Compte système » (pas d'email ni de personne), ajout de membre échoué, ou upload usurpé échoué.
- **Diagnostic** au pré-comptage (logs) : `attribution prévue: X/Total à leur auteur, Y en repli admin` + la liste des auteurs en repli — permet de distinguer « pas encore migrés » (normal) d'un éventuel souci de matching.

### 12.7 Historique des versions (option `migrate_versions`, défaut activé)

- Rejoue l'historique : le fichier est créé depuis la **version la plus ancienne**, puis chaque version suivante est empilée comme **révision Drive** (`keepRevisionForever=true`).
- **Attribution par version** : créé par = plus ancien auteur, modifié par = dernier ; chaque révision usurpée par son auteur (`listItemVersions` fournit `lastModifiedBy` par version). `modifiedTime` final = dernière version.
- Repli sur la version courante si l'API `/versions` échoue ou ≤ 1 version. Garde-fou taille appliqué **par version**.
- ⚠️ **Limite Drive** : la date d'une **révision** reflète l'instant de l'upload (non inscriptible) ; seul le `modifiedTime` global du fichier est réglé. Contenu + ordre des versions préservés et restaurables.
- ⚠️ Migrer les versions **multiplie** le volume téléchargé/uploadé (≈ × nombre de versions) → décocher pour un transfert rapide. Le compteur d'octets/la barre restent calés sur la taille de la version courante.

### 12.8 Limites v1 assumées (→ phases suivantes)

- **Dossiers** créés par le compte admin (pas d'attribution d'auteur).
- **Permissions SharePoint** non migrées — décision : **remise à plat des droits avec les responsables de service** (pas un copier-coller des ACL SharePoint).

### 12.9 Synchro delta (stratégie de bascule)

**Pourquoi.** Débits mesurés en août 2026 : ~24 Go/h **mais seulement ~2 470 fichiers/h**. C'est le nombre de fichiers qui commande, pas le volume — chaque fichier coûte 4-5 allers-retours API incompressibles.

| Dossier | Fichiers | Taille | Moyenne / fichier | Durée |
|---|---|---|---|---|
| Contrôle de gestion | 29 654 | 293 Go | ~10 Mo | ~12 h |
| ADV | 158 519 | 196 Go | ~1,3 Mo | ~30-60 h estimées |

L'ADV est **plus petit en volume mais plus long à migrer** que le CDG. Conclusion : **la bascule complète en un seul week-end (62 h) n'est pas jouable.**

**La méthode.** Pré-migrer maintenant, en semaine, sans contrainte → passes delta hebdomadaires → dernière passe delta courte le jour J. Le week-end sert à **figer**, pas à transférer.

**Comment ça marche.** Relancer une migration terminée déclenche une passe delta (bouton **« Synchroniser (delta) »**). Pour chaque fichier déjà transféré, on compare le `lastModifiedDateTime` de Graph à une date de référence :

- **inchangé** (cas massivement majoritaire) → sauté, coût ≈ un appel de listage partagé entre 1 000 items ;
- **modifié** → nouvelle **révision** sur le `gd_file_id` existant (jamais un second fichier : cela dupliquerait et casserait les liens partagés), puis `modifiedTime` remis à jour ;
- **absent** → migré normalement.

**Date de référence** = `sp_last_modified` (relevée au moment du transfert), ou à défaut `created_at` de la ligne pour les fichiers migrés avant l'ajout de la colonne. Ce repli est une borne sûre — un fichier modifié *avant* qu'on le copie est forcément déjà à jour — et il évite de re-télécharger les 293 Go déjà migrés du CDG.

⚠️ Une passe delta **parcourt quand même toute l'arborescence Graph** pour comparer les dates. Sur l'ADV, compter ~30-60 min de balayage même si rien n'a bougé, plus le transfert du delta réel.

Compteur `updated_items` = fichiers ré-uploadés par une passe delta (affiché « N mis à jour » dans l'UI).

### 12.10 🔙 Retour arrière (rollback)

**Point de retour connu-bon** : tag Git `stable-2026-08-12-avant-delta` (commit `fff2a12`) — état où toutes les migrations (mail, boîtes partagées, SharePoint, comptes) sont opérationnelles en prod.

Voir ce qui a changé depuis :

```bash
git log --oneline stable-2026-08-12-avant-delta..main
```

**Annuler une livraison fautive** — toujours par `revert`, jamais par `reset`/force-push sur `main` (le déploiement Azure suit `main`) :

```bash
git revert -m 1 <sha-du-merge-commit> && git push
```

Le push redéclenche les deux workflows et redéploie l'état précédent en ~5 min.

**Côté base de données, rien à défaire.** Toutes les évolutions de schéma passent par `ensureSchemaPatches()` et sont **strictement additives** (nouvelles colonnes avec `DEFAULT`, nouvelles tables). Une version antérieure du code ignore simplement les colonnes qu'elle ne connaît pas. Ne **jamais** écrire de `DROP COLUMN` dans les patches : c'est ce qui rendrait un retour arrière destructeur.

**Côté données déjà migrées** : un revert ne supprime rien dans Google Drive. Les tables `sharepoint_migrated_items` gardent la trace de ce qui est passé, donc une reprise après retour arrière reste idempotente (les fichiers déjà migrés sont sautés). Si l'on veut vraiment repartir de zéro sur un Drive : vider le Shared Drive **et** supprimer la migration dans l'UI — sinon les fichiers seront considérés comme déjà transférés.

**Après tout redéploiement** : les workers in-process sont tués. Les migrations restées en `running` doivent être débloquées (bouton **Débloquer**) puis relancées.

### 12.11 Endpoints

| Endpoint | Usage |
|---|---|
| `GET /sharepoint-migration/resolve-site?url=` | URL de site → site + bibliothèques |
| `GET /sharepoint-migration/browse?driveId=&itemId=` | Naviguer dans une bibliothèque |
| `GET /sharepoint-migration/search-drives?q=` | Rechercher un Shared Drive Google par nom |
| `POST /sharepoint-migration` · `GET /history` · `GET /:id` | Créer / lister / détail |
| `POST /:id/run` · `/:id/pause` · `/:id/unstick` | Lancer-reprendre / pause / débloquer un worker hung |
| `GET /:id/errors` · `DELETE /:id` | Erreurs détaillées / supprimer le suivi |

### 12.12 Services externes ajoutés

- **Microsoft Graph (Sites/Drives)** : `/sites`, `/drives`, `/items/{id}/children`, `/items/{id}/content`, `/items/{id}/versions` (+ `/versions/{vid}/content`).
- **Google Drive API v3** (DwD) : `drives` (recherche Shared Drives), `files` (création dossiers, upload résumable, révisions via PATCH `keepRevisionForever`, `modifiedTime`), `permissions` (membre temporaire pour l'impersonation). `supportsAllDrives=true` partout.

---

## 13. Module `accounts` (Création de comptes — onboarding nouvel arrivant)

Ajouté le **01/07/2026**. Provisionne un **nouvel arrivant** ONELA de bout en bout. Réutilise les primitives du module migration (création GOH, attributs, OU, alias, send-as) et ajoute la création d'un **objet de routage léger** côté Exchange ONELA. Module indépendant, provisioning en background (fire-and-forget après réponse `202`).

> Ajouté à la table des modules (§2). Route `/accounts`, permissions `accounts:read` / `accounts:write` (rôles `it_team` + `admin`).

### 13.1 Décision d'architecture (le « pourquoi ONELA »)

Pendant la migration, `onela.com` reste un domaine **autoritatif sur Exchange Online (tenant ONELA)** : tout mail entrant vers `prenom.nom@onela.com` frappe Exchange en premier et **bounce** s'il n'existe aucun objet destinataire (Exchange ne relaie pas vers Google tout seul). Il faut donc créer *quelque chose* côté ONELA — mais **pas** une mailbox complète.

Pour un nouvel arrivant **Google-native dès J1** (boîte vide, rien à migrer), on crée un **MailContact** léger :
- `ExternalEmailAddress` (targetAddress) = `prenom.nom@mig.onela.com` → route vers Google ;
- `EmailAddresses` primaire = `SMTP:prenom.nom@onela.com` → adresse acceptée par l'org.

Résultat : entrant `@onela.com` → résolu sur le contact → redirigé vers `mig.onela.com` → Google. **Zéro licence M365, zéro mailbox, zéro compte AAD, rien à décommissionner.**

> **MailUser écarté** : en Exchange Online, `New-MailUser` impose `-MicrosoftOnlineServicesID` + `-Password` → crée un compte AAD login-capable dans le tenant ONELA. Trop lourd pour du routage pur. Pour basculer sur MailUser si les conventions du tenant l'exigent : remplacer `New-MailContact`/`Set-MailContact` dans `onelaRoutingService.ts`.

### 13.2 Flux (étapes tracées)

| # | Étape | Détail |
|---|---|---|
| 1 | `stepCreateGoh` | Création compte GOH/Ouihelp `prenom.nom@mig.onela.com` (attributs complets : service/trigramme, poste, adresse siège/agence, `usageLocation=FR`, `preferredLanguage=fr-FR`). |
| 2 | `stepSetAttributes` | `extensionAttribute10` (`@onela.fr`) + `11` (`@onela.com` = `mail`) ; **manager** via Graph `manager/$ref` (non bloquant si le manager n'existe pas encore dans GOH). |
| 3 | `stepOnelaRouting` | **MailContact** Exchange ONELA (cf. §13.1) via `InvokeCommand` (`New-MailContact` / `Set-MailContact`). Idempotent (`Get-MailContact` d'abord). |
| 4 | `stepGoogleProvision` | Attente du **SCIM** : polling `googleUserExists` (60 s × 45 ≈ 45 min). |
| 5 | `stepOuMove` | Bascule **automatique** sur l'OU `/onela.com` (`GOOGLE_ONELA_OU_PATH`). |
| 6 | `stepNewFormat` | Alias `prenom.nom@onela.com` (`addGoogleAlias`, 409 ignoré) + `send-as` par défaut (`ensureSendAs` / `setSendAsAsDefault`). |

- **Étapes 1-3** = `provisionBackground` (fire-and-forget après `202`). **4-6** = `finalizeGoogleBackground`, enchaîné automatiquement.
- **Robustesse** : le poller SCIM est un background in-process → un **redéploiement le tue** (comme les workers de migration). Fallback : bouton **« Finaliser sur Google »** (`POST /:id/finalize-google`) qui reprend 4-6. Bouton **« Relancer le provisioning »** (`POST /:id/retry`) rejoue 1-3.

### 13.3 Schéma DB

- Table `account_creations` (1 ligne par onboarding), ajoutée via le pattern idempotent `ensureSchemaPatches` (gardé par `tableExists`), **pas** de migration drizzle versionnée. Clé unique sur `goh_upn` (idempotence : refuse un 2ᵉ onboarding pour le même compte).

### 13.4 Données de référence

Portées de l'ancienne app interne (`create_user`) dans `packages/shared/src/types/accounts.ts`, exportées comme **valeurs** (pas seulement des types) : `ONELA_SERVICES` (16 services siège), `ONELA_AGENCIES` (66 agences : trigramme = `department`, région = `state`, adresse/CP/ville), `AGENCY_JOB_TITLES`, `HEAD_OFFICE` (Boulogne-Billancourt).

### 13.5 ⚠️ Prérequis d'exploitation (à valider en prod)

- **App reg ONELA** : droit d'écriture Exchange (`Exchange.ManageAsApp` + rôle *Recipient Management* sur le SPN) pour `New-MailContact`. Confirmé en place côté ONELA.
- **1ʳᵉ création à tester** : que `prenom.nom@onela.com` (domaine autoritatif) soit accepté comme adresse d'un MailContact et route bien vers `mig.onela.com` ; que le passage d'`EmailAddresses` en tableau JSON via `InvokeCommand` fonctionne. Non testable hors tenant live.
- **Licence Google Workspace** : pour que le nouvel arrivant ait Gmail, l'OU `/onela.com` (ou un groupe) doit **auto-attribuer** une licence côté Google — config Workspace, hors app.
- `forceChangePassword` s'applique au compte **Entra GOH** (l'auth Google peut être SSO/séparée).

### 13.6 Endpoints

| Endpoint | Usage |
|---|---|
| `GET /accounts/search-managers?q=` | Autocomplétion manager (recherche tenant GOH) |
| `POST /accounts` · `GET /history` · `GET /:id` | Créer (202) / lister / détail |
| `POST /:id/finalize-google` | Reprendre la finalisation Google (SCIM → OU → alias) |
| `POST /:id/retry` | Rejouer le provisioning (étapes 1-3 en erreur) |
| `DELETE /:id` (`?purgeRouting=1`) | Supprimer le suivi (+ le MailContact ONELA si `purgeRouting`) |
