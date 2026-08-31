# Module `sharepoint-ximi` — Migration SharePoint ONELA → Ouihelp

Recopie les **sites d'agence** du tenant SharePoint ONELA vers des sites
équivalents du tenant Ouihelp, et produit le **tableau de mappage** remis à Ximi
pour qu'ils repointent les URL dans leur application.

Module indépendant de `sharepoint-migration` (qui, lui, va vers Google Drive) :
son propre worker, sa propre UI, ses propres tables.

## Ce qu'il fait

1. **Liste** les sites du tenant ONELA et déduit l'agence de chacun (référentiel
   `ONELA_AGENCIES`).
2. **Crée** le site cible sur Ouihelp — site de communication, via
   `/_api/SPSiteManager/create`.
3. **Donne accès** au groupe dynamique de l'agence (`ONELA - SG-DYN-AG-<TRI>`),
   ajouté au groupe SharePoint « Membres » du site.
4. **Pré-migre** tout le contenu (énumération complète).
5. **Synchronise** ensuite en delta : ajouts, modifications, **suppressions**,
   **renommages** et **déplacements**.
6. **Exporte** le mappage ONELA ↔ Ouihelp en CSV.

## Pourquoi le delta est complet ici (et pas dans le module Drive)

La cible étant SharePoint, la source peut être parcourue avec
`GET /drives/{id}/root/delta`. Cette API renvoie les items supprimés (facette
`deleted`) et les changements de `parentReference` / `name`. Le module Drive, qui
compare des dates de dernière modification, ne peut voir ni les suppressions ni
les déplacements — c'est sa limite documentée, et c'est celle que ce module lève.

Le **jeton delta** n'est enregistré qu'à la fin d'une passe complète non
interrompue. Une passe mise en pause repart d'une énumération complète, qui est
idempotente grâce à `ximi_migrated_items` : jamais un jeton qui ferait sauter des
changements non appliqués.

## Prérequis (sinon erreurs à l'exécution)

**App Entra ONELA** (déjà en place pour `sharepoint-migration`) :
`Sites.Read.All`, `Files.Read.All` (application).

**App Entra Ouihelp** :

| Permission | API | Pour quoi |
|---|---|---|
| `Sites.ReadWrite.All` | Microsoft Graph | créer dossiers/fichiers, déplacer, supprimer |
| `Group.Read.All` | Microsoft Graph | résoudre les groupes dynamiques par nom |
| `Sites.FullControl.All` | SharePoint | `SPSiteManager/create` + groupes de permission |

⚠️ **Un certificat est obligatoire.** SharePoint REST refuse les jetons app-only
obtenus avec un secret client (« Unsupported app only token »). Le module signe
donc une assertion JWT RS256 : il faut téléverser un certificat sur l'app Entra
Ouihelp et renseigner `OUIHELP_SP_CERT_KEY` (clé privée PEM) +
`OUIHELP_SP_CERT_THUMBPRINT` (empreinte SHA-1). Le secret client reste utilisé
pour Graph — les deux coexistent sans problème.

**Groupes dynamiques** : ils doivent exister **sur le tenant Ouihelp** avec le
nom exact `ONELA - SG-DYN-AG-<TRIGRAMME>` (motif surchargeable par
`XIMI_DYNAMIC_GROUP_PATTERN`). Un groupe introuvable ne bloque pas le transfert :
l'étape passe en erreur, visible sur la carte, et se rejoue seule via
« Réappliquer les droits ».

## Variables d'environnement

Voir `apps/api/.env.example`, section « Module Migration SharePoint Ximi ».
Les réglages de débit et de mémoire (`SHAREPOINT_MEM_BUDGET_MB`,
`SHAREPOINT_STREAM_THRESHOLD_MB`, `SHAREPOINT_MAX_FILE_MB`) sont partagés avec le
module Drive ; `XIMI_BATCH_SIZE` pilote le parallélisme de ce module seul
(plafond 10 — au-delà, Graph throttle et le débit baisse).

## Limites assumées

- **Auteur des fichiers non préservé.** Les dates de création/modification le
  sont (`fileSystemInfo`), mais « Créé par / Modifié par » côté cible sera le
  compte d'application. L'usurpation d'auteur du module Drive n'a pas
  d'équivalent app-only en écriture SharePoint. Ximi manipule des URL et des
  fichiers, pas de l'attribution.
- **Historique des versions non repris** : seule la version courante est
  transférée. Les révisions suivantes s'empilent normalement côté cible.
- **Permissions internes au site non migrées** — le partage se fait au niveau du
  site, au groupe dynamique de l'agence, comme décidé.
- **Sens unique ONELA → Ouihelp.** Un fichier modifié côté Ouihelp est écrasé si
  la source bouge ensuite. Règle opérationnelle : **un seul côté à la fois**.
- Une suppression côté source envoie l'item **à la corbeille** du site cible
  (récupérable 93 jours), jamais une suppression définitive.
