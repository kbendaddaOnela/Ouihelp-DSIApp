import type { StepStatus } from './migration'

/**
 * Migration d'une bibliothèque (ou d'un sous-dossier) d'un site SharePoint ONELA
 * vers un Google Shared Drive (Drive partagé) du Workspace OUIHELP/GOH.
 *
 * Module INDÉPENDANT de la migration utilisateur (étapes 1→8) : son propre worker,
 * sa propre UI. Pas de licence consommée côté Google (un Shared Drive est un objet
 * de domaine, pas un Mon Drive utilisateur).
 */

/** Statut global d'une migration SharePoint → Shared Drive */
export type SharepointMigrationStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'success'
  | 'error'

/** Drive (= bibliothèque de documents) d'un site SharePoint */
export interface SharepointDrive {
  id: string
  name: string
  driveType: string | null
  webUrl: string | null
}

/** Résultat de la résolution d'une URL de site SharePoint */
export interface ResolveSiteResponse {
  site: {
    id: string
    name: string
    displayName: string | null
    webUrl: string | null
  }
  drives: SharepointDrive[]
}

/** Un élément (fichier ou dossier) listé dans un drive SharePoint */
export interface SharepointItem {
  id: string
  name: string
  isFolder: boolean
  size: number | null
  childCount: number | null
  webUrl: string | null
}

export interface BrowseResponse {
  /** Chemin du dossier courant (fil d'Ariane simple), null = racine du drive */
  folderPath: string | null
  items: SharepointItem[]
}

/** Un Shared Drive (Drive partagé) Google existant, créé manuellement côté admin */
export interface GoogleSharedDrive {
  id: string
  name: string
}

export interface SearchSharedDrivesResponse {
  drives: GoogleSharedDrive[]
}

/** Demande de création d'une migration SharePoint → Shared Drive */
export interface CreateSharepointMigrationRequest {
  /** URL d'origine du site (mémorisée pour traçabilité / réaffichage) */
  siteUrl: string
  siteId: string
  siteName: string
  /** Drive (bibliothèque) source sélectionné */
  driveId: string
  driveName: string
  /** Sous-dossier source à migrer ; null = racine du drive (toute la bibliothèque) */
  rootItemId: string | null
  rootPath: string | null
  /** Shared Drive Google cible — créé MANUELLEMENT par l'admin, sélectionné via recherche */
  gdSharedDriveId: string
  /** Nom du Shared Drive sélectionné (affichage) */
  gdSharedDriveName: string
}

export interface SharepointMigrationRecord {
  id: string
  siteUrl: string
  siteId: string
  siteName: string
  driveId: string
  driveName: string
  rootItemId: string | null
  rootPath: string | null
  gdSharedDriveId: string | null
  gdSharedDriveName: string
  status: SharepointMigrationStatus
  totalItems: number
  migratedItems: number
  failedItems: number
  totalBytes: number
  migratedBytes: number
  errorDetails: string | null
  startedAt: string | null
  finishedAt: string | null
  initiatedBy: string
  createdAt: string
  updatedAt: string
}

export interface SharepointMigrationHistoryResponse {
  migrations: SharepointMigrationRecord[]
}

export interface SharepointMigrationErrorsResponse {
  errors: Array<{
    id: number
    spItemId: string
    name: string | null
    spPath: string | null
    isFolder: boolean
    sizeBytes: number | null
    errorDetails: string | null
    createdAt: string
  }>
}

/** Réutilise le vocabulaire d'étape commun au reste de l'app */
export type { StepStatus }
