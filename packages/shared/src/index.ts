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
} from './types/migration'

export type {
  SharedMailbox,
  CreateSharedMigrationRequest,
  SharedMigrationRecord,
  SearchSharedMailboxesResponse,
  SharedMigrationHistoryResponse,
} from './types/sharedMailbox'

export type {
  AccountStepStatus,
  AssignmentType,
  AgencyInfo,
  ManagerCandidate,
  SearchManagersResponse,
  CreateAccountRequest,
  AccountCreationRecord,
  CreateAccountResponse,
  AccountHistoryResponse,
} from './types/accounts'
export {
  ONELA_SERVICES,
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
  GoogleSharedDrive,
  SearchSharedDrivesResponse,
  CreateSharepointMigrationRequest,
  SharepointMigrationRecord,
  SharepointMigrationHistoryResponse,
  SharepointMigrationErrorsResponse,
} from './types/sharepointMigration'
