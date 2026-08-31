export type { Role, Permission } from './types/roles'
export { ROLE_PERMISSIONS, hasPermission } from './types/roles'

export type { AppUser, MeResponse, EntraIdJwtPayload } from './types/auth'

export type { ApiSuccess, ApiError, PaginationMeta, PaginatedResponse } from './types/api'

export type {
  StepStatus,
  OnelaUser,
  MigrationRecord,
  MigrateUsersRequest,
  MigrateExistingRequest,
  MigrateUsersResponse,
  SearchOnelaUsersResponse,
  MigrationHistoryResponse,
  MigratedUpnsResponse,
} from './types/migration'

export type {
  SharedMailbox,
  SharedMigrationMode,
  SharedMailboxDelegate,
  DelegateCandidate,
  DelegateCandidatesResponse,
  GoogleUserSuggestion,
  SearchGoogleUsersResponse,
  CreateSharedMigrationRequest,
  SharedMigrationRecord,
  SearchSharedMailboxesResponse,
  SharedMigrationHistoryResponse,
} from './types/sharedMailbox'

export type {
  AccountStepStatus,
  AssignmentType,
  AgencyInfo,
  Agency,
  AgencyInput,
  AgenciesResponse,
  ManagerCandidate,
  SearchManagersResponse,
  CreateAccountRequest,
  AccountCreationRecord,
  CreateAccountResponse,
  AccountHistoryResponse,
} from './types/accounts'
export {
  ONELA_SERVICES,
  ONELA_REGIONS,
  AGENCY_JOB_TITLES,
  HEAD_OFFICE,
  ONELA_AGENCIES,
} from './types/accounts'

export type {
  SharepointMigrationStatus,
  SharepointDrive,
  ResolveSiteResponse,
  SharepointItem,
  BrowseResponse,
  SharepointSelectedRoot,
  SharepointAnalysisBucket,
  GoogleSharedDrive,
  SearchSharedDrivesResponse,
  CreateSharepointMigrationRequest,
  SharepointMigrationRecord,
  SharepointMigrationHistoryResponse,
  SharepointMigrationErrorsResponse,
  SharepointChangedItem,
  SharepointMigrationChangesResponse,
} from './types/sharepointMigration'

export type {
  XimiMigrationStatus,
  XimiStepStatus,
  XimiSourceSite,
  XimiSourceSitesResponse,
  XimiTargetGroup,
  XimiTargetGroupsResponse,
  CreateXimiMigrationRequest,
  XimiMigrationRecord,
  XimiMigrationHistoryResponse,
  XimiMappingRow,
  XimiMappingResponse,
  XimiProblemItem,
  XimiMigrationErrorsResponse,
  XimiChangedItem,
  XimiMigrationChangesResponse,
} from './types/ximiMigration'
