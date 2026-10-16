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
 * Cycle d'une bascule (les deux modes partagent les statuts) :
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

/**
 * - inplace : bascule en place, Windows et applications conservés, profil transféré au compte
 *   Ouihelp (Win32_UserProfile.ChangeOwner) ; « resetting » = bascule en cours sur le poste.
 * - reset   : réinstallation propre (Supprimer tout), profil perdu.
 */
export type MigrationMode = 'inplace' | 'reset'

/**
 * Devenir d'un profil Windows ONELA à la bascule en place :
 * - migrate : profil conservé et donné au compte Ouihelp (un seul par poste, le dernier connecté) ;
 * - delete  : profil supprimé du poste (clé ProfileList et dossier de C:\Users). Le compte ONELA
 *   ne pourra de toute façon plus ouvrir de session une fois le poste sorti du tenant.
 */
export type MigrationProfileAction = 'migrate' | 'delete'

/** Profil Windows ONELA du poste et ce qu'il devient à la bascule en place. */
export interface MigrationProfileMapping {
  oldSid: string
  /** Compte tel que vu sur le PC (DOMAINE\compte ou UPN) */
  oldAccount: string | null
  oldUpn: string | null
  localDataMb: number | null
  /** Dernière ouverture de session connue : c'est elle qui désigne le profil conservé */
  lastLogonAt: string | null
  action: MigrationProfileAction
  /** Compte Ouihelp retenu (profil conservé uniquement) */
  newUpn: string | null
  newSid: string | null
  /** Partie avant « @ » du compte Ouihelp (nom du profil Windows) */
  newSam: string | null
  /** D'où vient le compte Ouihelp : table des migrations de comptes, adresse mail, saisie DSI */
  source: 'migration' | 'mail' | 'manual' | null
  /** Correspondance impossible (compte introuvable, désactivé…) */
  error: string | null
}

export interface MigrationProfilesResponse {
  profiles: MigrationProfileMapping[]
}

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
  /** true = prévenir l'utilisateur connecté et attendre son accord ; false = seulement hors session */
  promptUser: boolean
  /** Nombre de reports déjà demandés par l'utilisateur */
  snoozeCount: number
  /** L'utilisateur a reporté le maximum de fois : la DSI doit relancer */
  snoozeExhausted: boolean
  /** Profils transférés (bascule en place) */
  profiles: MigrationProfileMapping[]
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
  /** true (défaut) : prévenir l'utilisateur et attendre « Démarrer » ; false : agir hors session */
  promptUser?: boolean
  /**
   * Bascule en place : profil conservé et transféré (SID). Absent = le dernier profil connecté.
   * Tous les autres profils ONELA du poste sont supprimés.
   */
  mainProfileSid?: string | null
  /**
   * Bascule en place : compte Ouihelp choisi par la DSI pour un profil (clé = SID du profil).
   * Seul celui du profil conservé est utilisé. Absent = correspondance automatique.
   */
  profileTargets?: Record<string, string | null>
}

/** Avertissement affiché à l'utilisateur en mode « session ouverte ». */
export const MIGRATION_PROMPT_MESSAGE =
  'La DSI va mettre à jour votre PC. Enregistrez votre travail. Après le redémarrage, connectez-vous avec votre adresse et votre mot de passe Ouihelp.'
export const MIGRATION_SNOOZE_MINUTES = 15
export const MIGRATION_MAX_SNOOZES = 3

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
  /** Prévenir l'utilisateur connecté et attendre son accord avant de basculer */
  promptUser: boolean
  /** Message affiché à l'utilisateur */
  promptMessage: string
  /** Durée d'un report, en minutes */
  snoozeMinutes: number
  /** Nombre maximum de reports */
  maxSnoozes: number
  /** Reports déjà demandés (le bouton « Plus tard » disparaît une fois le maximum atteint) */
  snoozeCount: number
  /** Bascule en place : profil à transférer (SID ONELA → SID Ouihelp). Un seul aujourd'hui. */
  profileMap: Array<{ oldSid: string; oldUpn: string | null; newSid: string; newUpn: string; newSam: string }>
  /**
   * Bascule en place : profils à supprimer du poste (clé ProfileList et dossier) juste après le
   * transfert. L'agent ne supprime jamais un profil chargé, système ou local.
   */
  removeProfiles: Array<{ sid: string; account: string | null; upn: string | null }>
  /**
   * Bascule en place : applications à désinstaller (nom exact tel que remonté par l'agent).
   * L'agent n'exécute que la désinstallation enregistrée localement (MSI ou QuietUninstallString).
   */
  removeApps: string[]
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

/** Application installée (clés Uninstall HKLM, hors composants système et mises à jour). */
export interface DeviceAgentApp {
  name: string
  version: string | null
  publisher: string | null
  /** Désinstallation silencieuse possible (MSI ou QuietUninstallString) */
  uninstallable: boolean
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
  /** Applications installées (agent ≥ 1.2.0) */
  apps?: DeviceAgentApp[]
}

// ── Catalogue des applications (bascule en place) ───────────────────────────

/**
 * Règle DSI par application, valable pour tout le parc. Clé = nom normalisé (sans numéro de
 * version) pour qu'une mise à jour ne fasse pas réapparaître l'application comme nouvelle.
 * keep : true = conservée, false = désinstallée à la bascule, null = pas encore revue (conservée).
 */
export interface DeviceAppCatalogEntry {
  key: string
  name: string
  publisher: string | null
  /** Nombre de postes (avec agent) où l'application est installée */
  deviceCount: number
  /** Dont postes où la désinstallation silencieuse est possible */
  uninstallableCount: number
  keep: boolean | null
  updatedBy: string | null
  updatedAt: string | null
}

export interface DeviceAppCatalogResponse {
  apps: DeviceAppCatalogEntry[]
}

export interface UpdateAppRuleRequest {
  keys: string[]
  keep: boolean | null
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
