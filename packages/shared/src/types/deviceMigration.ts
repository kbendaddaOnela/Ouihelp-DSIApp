// Types du module Migration des postes (PC ONELA → tenant Ouihelp)

/**
 * Type de jonction déduit de l'objet Entra ONELA principal (trustType) :
 * - entra_joined : AzureAd (Entra Joined, en général Intune / Autopilot)
 * - hybrid       : ServerAd (joint à l'AD local ONELA + synchronisé dans Entra)
 * - registered   : Workplace (Entra registered seul — AD local ou workgroup)
 * - unknown      : vu par Intune / Autopilot sans objet Entra correspondant
 */
export type DeviceJoinType = 'entra_joined' | 'hybrid' | 'registered' | 'unknown'

/**
 * État dérivé pour le suivi (lot 1 — inventaire) :
 * - migrated : le PC remonte dans Intune ou Autopilot Ouihelp (rapprochement par n° de série)
 * - excluded : écarté manuellement (PC rebut, prêt, salle de réunion…)
 * - stale    : aucune activité ONELA (Entra / Intune) depuis plus de 90 jours
 * - gone     : n'apparaît plus dans ONELA à la dernière synchro et pas vu chez Ouihelp
 * - to_migrate
 */
export type DeviceMigrationState = 'to_migrate' | 'migrated' | 'excluded' | 'stale' | 'gone'

/** Un objet Entra ONELA rattaché au poste (un PC hybride a souvent 2 objets : ServerAd + Workplace). */
export interface DeviceEntraObject {
  objectId: string
  deviceId: string
  trustType: string | null
  accountEnabled: boolean
  approximateLastSignInDateTime: string | null
  registrationDateTime: string | null
  isManaged: boolean | null
}

export interface DeviceMigrationRecord {
  id: string
  deviceKey: string
  displayName: string | null
  serialNumber: string | null
  manufacturer: string | null
  model: string | null
  osVersion: string | null
  joinType: DeviceJoinType
  state: DeviceMigrationState
  /** Dernière activité ONELA connue (max connexion Entra / synchro Intune) */
  lastActivityAt: string | null

  onelaEntraDeviceId: string | null
  onelaEntraObjects: DeviceEntraObject[]
  onelaIntuneId: string | null
  onelaIntuneLastSync: string | null
  onelaManagementAgent: string | null
  onelaAutopilotId: string | null
  onelaAutopilotGroupTag: string | null
  onelaUserUpn: string | null
  onelaUserName: string | null
  /** officeLocation de l'utilisateur ONELA principal (= agence) */
  onelaOfficeLocation: string | null
  onelaDepartment: string | null
  /** Région ONELA, déduite de l'agence (table agencies) */
  region: string | null
  isEncrypted: boolean | null
  freeStorageGb: number | null
  totalStorageGb: number | null
  /** Nombre de clés BitLocker séquestrées dans Entra ONELA (null = non lu) */
  bitlockerKeysOnela: number | null

  ouihelpIntuneId: string | null
  ouihelpEntraDeviceId: string | null
  ouihelpAutopilotId: string | null
  ouihelpLastSync: string | null
  ouihelpUserUpn: string | null

  excluded: boolean
  excludeReason: string | null
  firstSeenAt: string
  lastSeenAt: string
}

export interface DeviceMigrationSyncState {
  running: boolean
  step: string | null
  startedAt: string | null
  finishedAt: string | null
  /** Erreur bloquante de la dernière synchro */
  error: string | null
  /** Sources non lues (permission manquante…) — la synchro continue sans elles */
  warnings: string[]
  /** Compteurs bruts par source lors de la dernière synchro */
  sources: Record<string, number>
}

export interface DeviceMigrationListResponse {
  devices: DeviceMigrationRecord[]
  sync: DeviceMigrationSyncState
  /** Début de la dernière synchro réussie (référence pour l'état « gone ») */
  lastSyncAt: string | null
}

export interface UpdateDeviceMigrationRequest {
  excluded: boolean
  excludeReason?: string | null
}
