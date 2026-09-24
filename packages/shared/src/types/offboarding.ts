// Types du module Offboarding (départ d'un collaborateur)

export type OffboardingActionType = 'reset_password' | 'add_delegate' | 'remove_delegate'

/** Compte Google trouvé par la recherche (annuaire Admin SDK). */
export interface OffboardingGoogleUser {
  id: string
  primaryEmail: string
  displayName: string
  suspended: boolean
  orgUnitPath: string
  aliases: string[]
}

export interface OffboardingSearchResponse {
  users: OffboardingGoogleUser[]
}

/** Compte Entra GOH (Ouihelp) correspondant au compte Google. */
export interface OffboardingEntraUser {
  id: string
  userPrincipalName: string
  displayName: string
  accountEnabled: boolean
}

export interface OffboardingDelegate {
  delegateEmail: string
  verificationStatus: string | null
}

/** Détail d'un utilisateur à offboarder. */
export interface OffboardingUserDetail {
  google: OffboardingGoogleUser & { isMailboxSetup: boolean }
  /** null si aucun compte Entra GOH n'a été trouvé (ex. compte créé directement dans Google) */
  entra: OffboardingEntraUser | null
  entraError: string | null
  delegates: OffboardingDelegate[]
  delegatesError: string | null
}

export interface ResetPasswordRequest {
  /** Adresse Google primaire de l'utilisateur */
  email: string
  /** Mot de passe imposé ; si absent, un mot de passe fort est généré */
  password?: string
  /** Révoque les sessions Entra en cours (défaut : true) */
  revokeSessions?: boolean
}

export interface ResetPasswordResponse {
  entraUpn: string
  /** Mot de passe posé — affiché une seule fois, jamais stocké */
  password: string
  sessionsRevoked: boolean
  revokeError: string | null
}

export interface AddOffboardingDelegateRequest {
  /** Boîte de l'utilisateur qui part (adresse Google primaire) */
  email: string
  /** Utilisateur Google qui récupère l'accès (primaire ou alias) */
  delegateEmail: string
}

export interface AddOffboardingDelegateResponse {
  delegateEmail: string
  created: boolean
  verificationStatus: string | null
}

export interface OffboardingActionRecord {
  id: string
  targetEmail: string
  targetDisplayName: string | null
  action: OffboardingActionType
  detail: string | null
  status: 'success' | 'error'
  errorDetails: string | null
  initiatedBy: string
  createdAt: string
}

export interface OffboardingHistoryResponse {
  actions: OffboardingActionRecord[]
}

/** Boîte déléguée via le module, avec ses délégations actuelles (lues dans Gmail). */
export interface OffboardingDelegatedMailbox {
  email: string
  displayName: string | null
  delegates: OffboardingDelegate[]
  /** Renseigné si la lecture Gmail a échoué (délégués alors déduits du journal) */
  error: string | null
}

export interface OffboardingDelegationsResponse {
  mailboxes: OffboardingDelegatedMailbox[]
}
