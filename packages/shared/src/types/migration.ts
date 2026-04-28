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
  mailTotal: number
  mailMigrated: number
  mailFailed: number
  mailError: string | null
  mailStartedAt: string | null
  mailFinishedAt: string | null
  initiatedBy: string
  errorDetails: string | null
  exchangePsScript: string | null
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

// Responses
export interface SearchOnelaUsersResponse {
  users: OnelaUser[]
}

export interface MigrateUsersResponse {
  migrations: MigrationRecord[]
}

export interface MigrationHistoryResponse {
  migrations: MigrationRecord[]
  total: number
}
