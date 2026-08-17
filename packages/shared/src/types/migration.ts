export type StepStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped'

export interface OnelaUser {
  id: string
  displayName: string
  givenName: string
  surname: string
  upn: string
  email: string
  department: string | null
  jobTitle: string | null
  companyName: string | null
}

export interface MigrationRecord {
  id: string
  onelaUserId: string
  onelaUpn: string
  onelaDisplayName: string
  onelaEmail: string
  onelaDepartment: string | null
  onelaJobTitle: string | null
  gohUserId: string | null
  gohUpn: string | null
  tempPassword: string | null
  stepCreateAccount: StepStatus
  stepSetAttributes: StepStatus
  stepGroupMembership: StepStatus
  stepMailMigration: StepStatus
  stepGoogleAlias: StepStatus
  googleAliasError: string | null
  stepOuMove: StepStatus
  ouMoveError: string | null
  stepNewFormat: StepStatus
  newFormatError: string | null
  mailTotal: number
  mailMigrated: number
  mailFailed: number
  mailError: string | null
  mailStartedAt: string | null
  mailFinishedAt: string | null
  mailLastSyncAt: string | null
  mailOrder: string
  mailBeforeDays: number | null
  stepCalendarMigration: StepStatus
  calTotal: number
  calMigrated: number
  calFailed: number
  calError: string | null
  calStartedAt: string | null
  calFinishedAt: string | null
  calLastSyncAt: string | null
  stepContactsMigration: StepStatus
  contactsTotal: number
  contactsMigrated: number
  contactsFailed: number
  contactsError: string | null
  contactsStartedAt: string | null
  contactsFinishedAt: string | null
  contactsLastSyncAt: string | null
  archived: boolean
  archivedAt: string | null
  initiatedBy: string
  errorDetails: string | null
  /** Script PowerShell Exchange — omis des listes (`/history`), présent sur `/migration/:id` */
  exchangePsScript?: string | null
  createdAt: string
  updatedAt: string
}

// Requests
export interface MigrateUsersRequest {
  users: {
    onelaUserId: string
    onelaUpn: string
    onelaDisplayName: string
    onelaEmail: string
    onelaDepartment: string | null
    onelaJobTitle: string | null
    givenName: string
    surname: string
  }[]
}

/** Migration vers un compte Google déjà existant (pas de création Entra GOH) */
export interface MigrateExistingRequest {
  onelaUserId: string
  onelaUpn: string
  onelaDisplayName: string
  onelaEmail: string
  onelaDepartment: string | null
  onelaJobTitle: string | null
  /** Email du compte Google cible déjà provisionné (ex: khalid.bendadda@ouihelp.fr) */
  targetGoogleEmail: string
}

// Responses
export interface SearchOnelaUsersResponse {
  users: OnelaUser[]
}

export interface MigrateUsersResponse {
  migrations: MigrationRecord[]
  /** Comptes ignorés (déjà une migration en cours pour ce user) */
  skipped?: Array<{ onelaUpn: string; reason: string; existingMigrationId: string }>
}

export interface MigrationHistoryResponse {
  migrations: MigrationRecord[]
  /** Nombre total de migrations correspondant au filtre (pas la taille de la page) */
  total: number
  page: number
  limit: number
  hasMore: boolean
}

/** UPN ONELA dont le compte GOH a déjà été créé (ou volontairement ignoré) */
export interface MigratedUpnsResponse {
  upns: string[]
}
