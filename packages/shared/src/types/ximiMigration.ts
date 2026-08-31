/**
 * Migration SharePoint Ximi : sites d'AGENCE du tenant SharePoint ONELA vers des
 * sites équivalents du tenant SharePoint Ouihelp.
 *
 * Différences fondamentales avec le module `sharepoint-migration` (→ Google Drive) :
 *  - la cible est SharePoint, pas Google Drive : on peut donc utiliser l'API
 *    `delta` de Graph côté source, qui rapporte AUSSI les suppressions, les
 *    renommages et les déplacements (le module Drive ne synchronise que le contenu) ;
 *  - un site cible est CRÉÉ par l'app (site de communication via SPSiteManager)
 *    puis partagé au groupe dynamique de l'agence ;
 *  - la sortie attendue est un TABLEAU DE MAPPAGE (site ONELA ↔ site Ouihelp)
 *    remis à Ximi pour qu'ils repointent les URL dans leur application.
 */

/** Statut global d'une migration de site */
export type XimiMigrationStatus = 'pending' | 'running' | 'paused' | 'success' | 'error'

/** Statut d'une étape ponctuelle (création du site, attribution des droits) */
export type XimiStepStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped'

/** Un site SharePoint découvert sur le tenant ONELA */
export interface XimiSourceSite {
  id: string
  name: string
  displayName: string | null
  webUrl: string | null
  /** Alias d'URL (dernier segment de /sites/<alias>) — sert de base au site cible */
  alias: string | null
  /** Trigramme d'agence déduit de l'alias/nom (ex. « ARG »), null si indéterminé */
  agencyTrigramme: string | null
  /** true si une migration existe déjà pour ce site (évite les doublons) */
  alreadyMigrated: boolean
}

export interface XimiSourceSitesResponse {
  sites: XimiSourceSite[]
  /** Nombre total de sites parcourus sur le tenant (avant filtrage) */
  scanned: number
}

/** Groupe (dynamique) du tenant Ouihelp candidat à l'attribution des droits */
export interface XimiTargetGroup {
  id: string
  displayName: string
  mail: string | null
  /** true = groupe à appartenance dynamique (membershipRule présente) */
  dynamic: boolean
}

export interface XimiTargetGroupsResponse {
  groups: XimiTargetGroup[]
}

/** Demande de création d'une migration de site (un site source = une ligne) */
export interface CreateXimiMigrationRequest {
  /** Site source (tenant ONELA) */
  sourceSiteUrl: string
  sourceSiteId: string
  sourceSiteName: string
  /**
   * Titre du site cible. Vide = même titre que la source.
   */
  targetSiteTitle?: string
  /**
   * Alias d'URL du site cible (→ https://<tenant>.sharepoint.com/sites/<alias>).
   * Vide = alias de la source.
   */
  targetSiteAlias?: string
  /**
   * Groupe dynamique d'agence du tenant Ouihelp à qui donner accès au site
   * (ex. « ONELA - SG-DYN-AG-ARG »). Vide = aucune attribution automatique.
   */
  dynamicGroupName?: string
  /** Id objet du groupe si déjà résolu côté UI (évite une recherche par nom) */
  dynamicGroupId?: string
  /**
   * Site cible DÉJÀ existant : on ne crée rien, on résout cette URL.
   * Sert aux agences dont le site a été créé à la main.
   */
  existingTargetSiteUrl?: string
  /** Libellé libre pour s'y retrouver dans la liste */
  label?: string
  /** Mode analyse : compte le contenu source sans rien créer ni transférer */
  analyzeOnly?: boolean
}

export interface XimiMigrationRecord {
  id: string
  label: string | null
  // ── Source (ONELA) ────────────────────────────────────────────────────────
  sourceSiteUrl: string
  sourceSiteId: string
  sourceSiteName: string
  sourceDriveId: string | null
  sourceDriveName: string | null
  // ── Cible (Ouihelp) ───────────────────────────────────────────────────────
  targetSiteUrl: string | null
  targetSiteId: string | null
  targetSiteName: string | null
  targetSiteAlias: string | null
  targetDriveId: string | null
  /** Création du site cible */
  siteStatus: XimiStepStatus
  siteError: string | null
  // ── Droits ────────────────────────────────────────────────────────────────
  dynamicGroupName: string | null
  dynamicGroupId: string | null
  permissionStatus: XimiStepStatus
  permissionError: string | null
  // ── Transfert ─────────────────────────────────────────────────────────────
  status: XimiMigrationStatus
  analyzeOnly: boolean
  totalItems: number
  migratedItems: number
  updatedItems: number
  deletedItems: number
  movedItems: number
  failedItems: number
  skippedItems: number
  scannedItems: number
  totalBytes: number
  migratedBytes: number
  processedBytes: number
  /** true dès qu'un jeton delta est mémorisé : les passes suivantes sont des deltas */
  hasDeltaToken: boolean
  lastDeltaAt: string | null
  errorDetails: string | null
  startedAt: string | null
  finishedAt: string | null
  archived: boolean
  archivedAt: string | null
  initiatedBy: string
  createdAt: string
  updatedAt: string
}

export interface XimiMigrationHistoryResponse {
  migrations: XimiMigrationRecord[]
  total: number
}

/** Une ligne du tableau de mappage remis à Ximi */
export interface XimiMappingRow {
  migrationId: string
  agency: string
  sourceSiteName: string
  sourceSiteId: string
  sourceSiteUrl: string
  targetSiteName: string | null
  targetSiteId: string | null
  targetSiteUrl: string | null
  dynamicGroupName: string | null
  permissionStatus: XimiStepStatus
  status: XimiMigrationStatus
  filesMigrated: number
  lastSyncAt: string | null
}

export interface XimiMappingResponse {
  rows: XimiMappingRow[]
  generatedAt: string
}

/** Un item problématique (erreur ou ignoré) */
export interface XimiProblemItem {
  id: number
  spItemId: string
  name: string | null
  spPath: string | null
  isFolder: boolean
  sizeBytes: number | null
  errorDetails: string | null
  createdAt: string
}

export interface XimiMigrationErrorsResponse {
  errors: XimiProblemItem[]
  skipped: XimiProblemItem[]
}

/** Un item touché par la dernière passe */
export interface XimiChangedItem {
  id: number
  name: string | null
  spPath: string | null
  sizeBytes: number | null
  spLastModified: string | null
  syncedAt: string | null
}

export interface XimiMigrationChangesResponse {
  runStartedAt: string | null
  createdCount: number
  updatedCount: number
  movedCount: number
  deletedCount: number
  truncated: boolean
  created: XimiChangedItem[]
  updated: XimiChangedItem[]
  moved: XimiChangedItem[]
  deleted: XimiChangedItem[]
}
