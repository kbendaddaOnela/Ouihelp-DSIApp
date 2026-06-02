import type { StepStatus } from './migration'

/** Boîte aux lettres partagée Exchange (RecipientTypeDetails = SharedMailbox) */
export interface SharedMailbox {
  id: string
  upn: string
  email: string
  displayName: string
  itemCount: number | null
}

/** Demande de création d'une migration de boîte partagée → Google Group */
export interface CreateSharedMigrationRequest {
  onelaUserId: string
  onelaUpn: string
  onelaEmail: string
  onelaDisplayName: string
  /** Adresse email du Google Group cible (sera créé si inexistant) */
  targetGroupEmail: string
  /** Nom d'affichage du Google Group (utilisé à la création) */
  targetGroupName: string
}

export interface SharedMigrationRecord {
  id: string
  onelaUserId: string
  onelaUpn: string
  onelaEmail: string
  onelaDisplayName: string
  targetGroupEmail: string
  targetGroupName: string
  targetGroupId: string | null
  stepCreateGroup: StepStatus
  createGroupError: string | null
  stepMailImport: StepStatus
  mailTotal: number
  mailMigrated: number
  mailFailed: number
  mailError: string | null
  mailStartedAt: string | null
  mailFinishedAt: string | null
  mailLastSyncAt: string | null
  dualDeliveryBccAddress: string | null
  initiatedBy: string
  createdAt: string
  updatedAt: string
}

export interface SearchSharedMailboxesResponse {
  mailboxes: SharedMailbox[]
}

export interface SharedMigrationHistoryResponse {
  migrations: SharedMigrationRecord[]
}
