// Types du module Migration des postes (PC ONELA → tenant Ouihelp)

/**
 * Type de jonction déduit de l'objet Entra ONELA principal (trustType) :
 * - entra_joined : AzureAd (Entra Joined, en général Intune / Autopilot)
 * - hybrid       : ServerAd (joint à l'AD local ONELA + synchronisé dans Entra)
 * - registered   : Workplace (Entra registered seul — AD local ou workgroup)
 * - ad_only      : joint à l'AD local sans objet Entra (connu uniquement par l'agent)
 * - unknown      : vu par Intune / Autopilot sans objet Entra correspondant
 */
export type DeviceJoinType = 'entra_joined' | 'hybrid' | 'registered' | 'ad_only' | 'unknown'

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
  /** Utilisateur principal Intune = celui qui a INSCRIT le PC (souvent un technicien) */
  onelaUserUpn: string | null
  onelaUserName: string | null
  /** Dernière personne réellement connectée (hors comptes techniques), toutes sources confondues */
  lastUser: DeviceLogon | null
  /** Connexions récentes, de la plus récente à la plus ancienne (dédoublonnées par compte) */
  recentLogons: DeviceLogon[]
  /** officeLocation de l'utilisateur ONELA principal (= agence) */
  onelaOfficeLocation: string | null
  onelaDepartment: string | null
  /**
   * Agence du poste : trigramme en préfixe du nom (« AIX-2023… ») rapproché de la table
   * agencies, sinon officeLocation de l'utilisateur ONELA
   */
  agency: string | null
  /** true si l'agence vient du nom du poste, false si de l'utilisateur */
  agencyFromName: boolean
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
  /** Dernier état remonté par l'agent DSI installé sur le PC (null = pas d'agent) */
  agent: DeviceAgentSummary | null
  /** Bascule vers Ouihelp en cours ou terminée (null = jamais programmée) */
  migration: DeviceMigrationRun | null
  /** Nom du poste chez Ouihelp (ONL-<site>-<n° de série>) ; null = impossible à déduire */
  targetName: string | null
  /** true = calculé par la convention ; false = saisi par la DSI (ou figé à la programmation) */
  targetNameAuto: boolean
  /** Autre poste qui aurait le même nom (bloque la programmation) */
  targetNameConflict: string | null
}

export interface UpdateTargetNameRequest {
  /** null = revenir au nom calculé */
  name: string | null
}

// ── Bascule (lot 3) ──────────────────────────────────────────────────────────

/**
 * Cycle d'une réinstallation propre :
 * scheduled (DSI) → staging (agent prépare) → staged (prêt, empreinte envoyée)
 * → cleanup (serveur retire le PC d'Autopilot ONELA) → ready → resetting (réinitialisation
 * lancée) → joining (le nouveau Windows a rendu compte) → done.
 * failed / cancelled : terminaux. Annulation possible jusqu'à « staged » inclus.
 */
export type MigrationStatus =
  | 'scheduled'
  | 'staging'
  | 'staged'
  | 'cleanup'
  | 'ready'
  | 'resetting'
  | 'joining'
  | 'done'
  | 'failed'
  | 'cancelled'

export type MigrationMode = 'reset'

export interface MigrationStep {
  at: string
  step: string
  status: 'info' | 'ok' | 'error'
  message: string
  /** dsi = action dans l'app ; agent = PC avant réinitialisation ; poste = nouveau Windows ; serveur = Graph */
  source: 'dsi' | 'agent' | 'poste' | 'serveur'
}

export interface DeviceMigrationRun {
  status: MigrationStatus
  mode: MigrationMode
  requestedBy: string | null
  requestedAt: string | null
  updatedAt: string | null
  error: string | null
  steps: MigrationStep[]
  hasBreakglass: boolean
}

export interface MigrationPackageInfo {
  id: string
  fileName: string
  sizeBytes: number
  sha256: string
  /** Fin de validité du jeton en bloc, saisie au téléversement */
  tokenExpiresAt: string | null
  uploadedBy: string
  uploadedAt: string
}

export interface MigrationPackageResponse {
  package: MigrationPackageInfo | null
}

export interface ScheduleMigrationRequest {
  mode: MigrationMode
}

/** Ordre transmis à l'agent dans la réponse du check-in. */
export interface DeviceAgentMigrationOrder {
  status: MigrationStatus
  mode: MigrationMode
  packageSha256: string
  ouihelpTenantId: string
  breakglassUser: string
  breakglassPassword: string
  /** Jeton à usage du nouveau Windows pour rendre compte (renvoyé pendant « staging ») */
  reportToken?: string
  /** Nom à donner au poste (appliqué après l'installation du PPKG) */
  computerName: string
}

/** Une ouverture de session constatée sur le poste. */
export interface DeviceLogon {
  /** UPN ONELA si connu, sinon compte tel que vu sur le PC (DOMAINE\compte) */
  account: string
  name: string | null
  at: string | null
  /** intune = usersLoggedOn (Graph beta) ; agent = chargement du profil Windows */
  source: 'intune' | 'agent'
}

// ── Agent DSI (lot 2) ────────────────────────────────────────────────────────

/** Profil Windows présent sur le PC. Les tailles ne comptent que les octets présents localement. */
export interface DeviceAgentProfile {
  sid: string
  /** DOMAINE\compte (AD) ou UPN (Entra) ; null si non résolu */
  account: string | null
  /** UPN (Entra, ou résolu auprès de l'AD) ; absent avant l'agent 1.0.3 */
  upn?: string | null
  /** Dernier chargement du profil = dernière ouverture de session (agent ≥ 1.0.3) */
  lastLogonTime?: string | null
  kind: 'ad' | 'entra' | 'local' | 'unknown'
  lastUseTime: string | null
  loaded: boolean
  /** Bureau + Documents + Téléchargements + dossiers OneDrive, en Mo (null = non mesuré) */
  localDataMb: number | null
}

/** Rapport envoyé par l'agent à chaque check-in (format v1). */
export interface DeviceAgentReport {
  agentVersion: string
  machineGuid: string
  hostname: string
  serialNumber: string | null
  manufacturer: string | null
  model: string | null
  os: {
    caption: string | null
    version: string | null
    build: string | null
    edition: string | null
  }
  domain: { partOfDomain: boolean; name: string | null }
  /** Extrait de dsregcmd /status (section état de l'appareil) */
  dsreg: {
    azureAdJoined: boolean
    domainJoined: boolean
    workplaceJoined: boolean
    deviceId: string | null
    tenantId: string | null
    tenantName: string | null
  }
  mdm: { enrolled: boolean; upn: string | null; gpoAutoEnroll: boolean }
  sccmClient: boolean
  tpm: { present: boolean; ready: boolean; version: string | null }
  secureBoot: boolean | null
  winreEnabled: boolean | null
  bitlocker: { protectionOn: boolean | null; hasRecoveryPassword: boolean | null }
  network: { ethernet: boolean; wifi: boolean; ssid: string | null; wifiProfiles: string[] }
  disk: { freeGb: number | null; totalGb: number | null }
  consoleUser: string | null
  lastBoot: string | null
  profiles: DeviceAgentProfile[]
  /** Date de la mesure des tailles de profil (recalculées au plus 1 fois par jour) */
  profilesMeasuredAt: string | null
}

export interface DeviceAgentSummary {
  id: string
  firstCheckinAt: string
  lastCheckinAt: string
  /** Pas de check-in depuis plus de 24 h */
  silent: boolean
  /** Le PC est déjà joint au tenant Ouihelp (dsregcmd) */
  joinedToOuihelp: boolean
  report: DeviceAgentReport
}

export interface DeviceAgentCheckinResponse {
  agentId: string
  /** Renvoyé uniquement au 1er enregistrement : à conserver par l'agent */
  deviceToken?: string
  nextCheckinMinutes: number
  /** Présent uniquement si une bascule est programmée pour ce poste */
  migration?: DeviceAgentMigrationOrder
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
