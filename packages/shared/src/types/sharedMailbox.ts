import type { StepStatus } from './migration'

/**
 * Mode de migration d'une boîte partagée.
 *
 * - `account` (nouveau, seul mode créable) : la BAL devient un **compte Google
 *   classique** (licence Business Plus attribuée hors app) sur lequel on active
 *   la **délégation Gmail** pour les personnes du service. Les mails de la BAL
 *   Exchange sont importés dans cette boîte, dossiers → libellés.
 * - `group` (legacy) : la BAL était archivée dans un Google Group. Conservé en
 *   lecture/relance pour l'historique, plus proposé à la création.
 */
export type SharedMigrationMode = 'group' | 'account'

/** Boîte aux lettres partagée Exchange (RecipientTypeDetails = SharedMailbox) */
export interface SharedMailbox {
  id: string
  upn: string
  email: string
  displayName: string
  itemCount: number | null
}

/** Un délégué Gmail sur la boîte cible. */
export interface SharedMailboxDelegate {
  id: number
  sharedMigrationId: string
  /** UPN Exchange source (pnom@onela.com) quand le délégué vient du FullAccess Exchange */
  sourceUpn: string | null
  /** Compte Google du délégué — adresse PRIMAIRE (prenom.nom@mig.onela.com) */
  googleEmail: string
  displayName: string | null
  status: StepStatus
  /** État Google : 'accepted' (utilisable), 'pending' (à valider par le délégué), … */
  verificationStatus: string | null
  errorDetails: string | null
  createdAt: string
}

/** Candidat à la délégation, proposé depuis les permissions FullAccess Exchange. */
export interface DelegateCandidate {
  /** UPN Exchange de la personne ayant FullAccess sur la BAL (pnom@onela.com) */
  sourceUpn: string
  /** Compte Google correspondant s'il a pu être résolu, sinon null */
  googleEmail: string | null
  displayName: string | null
  /** Comment le compte Google a été retrouvé */
  resolvedVia: 'migration' | 'directory' | null
  /** Déjà présent dans la liste des délégués de cette migration */
  alreadyAdded: boolean
}

export interface DelegateCandidatesResponse {
  candidates: DelegateCandidate[]
}

/** Résultat d'une recherche dans l'annuaire Google (ajout manuel d'un délégué). */
export interface GoogleUserSuggestion {
  id: string
  primaryEmail: string
  displayName: string
  suspended: boolean
}

export interface SearchGoogleUsersResponse {
  users: GoogleUserSuggestion[]
}

/** Demande de création d'une migration de boîte partagée → compte Google classique */
export interface CreateSharedMigrationRequest {
  onelaUserId: string
  onelaUpn: string
  onelaEmail: string
  onelaDisplayName: string
  /** Adresse PRIMAIRE du compte Google cible (ex. compta@mig.onela.com) */
  targetUserEmail: string
  /** Alias définitif du compte (ex. compta@onela.com) — devient l'adresse d'envoi par défaut */
  targetUserAlias: string
  /** Nom d'affichage du compte Google */
  targetDisplayName: string
  /** Délégués Gmail à activer sur la boîte cible */
  delegates?: Array<{
    googleEmail: string
    sourceUpn?: string | null
    displayName?: string | null
  }>
}

export interface SharedMigrationRecord {
  id: string
  mode: SharedMigrationMode
  onelaUserId: string
  onelaUpn: string
  onelaEmail: string
  onelaDisplayName: string
  // ── Cible « compte » (mode account) ──
  targetUserEmail: string | null
  targetUserAlias: string | null
  targetDisplayName: string | null
  targetUserId: string | null
  targetPassword: string | null
  stepCreateAccount: StepStatus
  createAccountError: string | null
  stepLicense: StepStatus
  licenseAckAt: string | null
  licenseAckBy: string | null
  stepAliasSendAs: StepStatus
  aliasSendAsError: string | null
  stepDelegates: StepStatus
  delegatesError: string | null
  delegates: SharedMailboxDelegate[]
  // ── Cible « groupe » (legacy) ──
  targetGroupEmail: string | null
  targetGroupName: string | null
  targetGroupId: string | null
  stepCreateGroup: StepStatus
  createGroupError: string | null
  // ── Import mail (commun) ──
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
