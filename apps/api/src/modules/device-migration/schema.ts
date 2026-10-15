import {
  mysqlTable,
  varchar,
  mysqlEnum,
  timestamp,
  int,
  text,
  mediumtext,
  index,
  uniqueIndex,
} from 'drizzle-orm/mysql-core'

const joinType = ['entra_joined', 'hybrid', 'registered', 'ad_only', 'unknown'] as const

/**
 * Un poste physique ONELA à basculer vers le tenant Ouihelp.
 *
 * Lot 1 (inventaire) : consolidation Entra + Intune + Autopilot ONELA, rapprochement
 * Ouihelp par n° de série. La synchro met à jour les colonnes d'inventaire mais ne
 * touche jamais `excluded` / `exclude_reason` (saisie DSI) ni `first_seen_at`.
 *
 * `device_key` = `sn:<SERIAL>` quand un n° de série fiable est connu, sinon
 * `aad:<deviceId Entra>`. La clé peut passer de aad: à sn: quand le PC est inscrit
 * dans Intune après coup — la synchro retrouve alors la ligne par son deviceId Entra.
 */
export const deviceMigrations = mysqlTable(
  'device_migrations',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    deviceKey: varchar('device_key', { length: 120 }).notNull(),
    displayName: varchar('display_name', { length: 255 }),
    serialNumber: varchar('serial_number', { length: 100 }),
    manufacturer: varchar('manufacturer', { length: 255 }),
    model: varchar('model', { length: 255 }),
    osVersion: varchar('os_version', { length: 100 }),
    joinType: mysqlEnum('join_type', joinType).default('unknown').notNull(),

    onelaEntraDeviceId: varchar('onela_entra_device_id', { length: 36 }),
    /** JSON DeviceEntraObject[] — tous les objets Entra ONELA rattachés au poste */
    onelaEntraObjects: text('onela_entra_objects'),
    onelaEntraLastSignIn: timestamp('onela_entra_last_sign_in'),
    onelaIntuneId: varchar('onela_intune_id', { length: 36 }),
    onelaIntuneLastSync: timestamp('onela_intune_last_sync'),
    onelaManagementAgent: varchar('onela_management_agent', { length: 50 }),
    onelaAutopilotId: varchar('onela_autopilot_id', { length: 64 }),
    onelaAutopilotGroupTag: varchar('onela_autopilot_group_tag', { length: 255 }),
    onelaUserUpn: varchar('onela_user_upn', { length: 255 }),
    onelaUserName: varchar('onela_user_name', { length: 255 }),
    onelaOfficeLocation: varchar('onela_office_location', { length: 255 }),
    onelaDepartment: varchar('onela_department', { length: 255 }),
    /** JSON StoredLogon[] — derniers utilisateurs connectés selon Intune (Graph beta usersLoggedOn) */
    intuneLogons: text('intune_logons'),
    isEncrypted: int('is_encrypted'),
    freeStorageGb: int('free_storage_gb'),
    totalStorageGb: int('total_storage_gb'),
    bitlockerKeysOnela: int('bitlocker_keys_onela'),

    ouihelpIntuneId: varchar('ouihelp_intune_id', { length: 36 }),
    ouihelpEntraDeviceId: varchar('ouihelp_entra_device_id', { length: 36 }),
    ouihelpAutopilotId: varchar('ouihelp_autopilot_id', { length: 64 }),
    ouihelpLastSync: timestamp('ouihelp_last_sync'),
    ouihelpUserUpn: varchar('ouihelp_user_upn', { length: 255 }),

    // ── Bascule (lot 3) ── colonnes jamais touchées par la synchro d'inventaire
    /** MigrationStatus ; null = jamais programmée */
    migrationStatus: varchar('migration_status', { length: 20 }),
    migrationMode: varchar('migration_mode', { length: 20 }),
    migrationRequestedBy: varchar('migration_requested_by', { length: 255 }),
    migrationRequestedAt: timestamp('migration_requested_at'),
    migrationUpdatedAt: timestamp('migration_updated_at'),
    migrationError: text('migration_error'),
    /** JSON MigrationStep[] */
    migrationSteps: mediumtext('migration_steps'),
    /** Mot de passe du compte local dsi-secours (en clair, comme les mots de passe temporaires) */
    breakglassPassword: varchar('breakglass_password', { length: 64 }),
    /** SHA-256 du jeton de compte rendu du nouveau Windows */
    migrationTokenHash: varchar('migration_token_hash', { length: 64 }),
    /** Empreinte matérielle Autopilot (base64), relevée par l'agent avant réinitialisation */
    hardwareHash: mediumtext('hardware_hash'),

    excluded: int('excluded').default(0).notNull(),
    excludeReason: varchar('exclude_reason', { length: 255 }),
    firstSeenAt: timestamp('first_seen_at').defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    uqKey: uniqueIndex('uq_device_migrations_key').on(t.deviceKey),
    idxSerial: index('idx_device_migrations_serial').on(t.serialNumber),
    idxEntra: index('idx_device_migrations_entra').on(t.onelaEntraDeviceId),
  })
)

export type DeviceMigrationRow = typeof deviceMigrations.$inferSelect
export type NewDeviceMigrationRow = typeof deviceMigrations.$inferInsert

/**
 * Agent DSI installé sur un PC (tâche planifiée SYSTEM, lot 2).
 *
 * Identifié par le MachineGuid Windows + n° de série (le MachineGuid seul est partagé
 * par les PC clonés d'un même master). Au 1er
 * check-in, authentifié par la clé d'enrôlement commune, l'agent reçoit un jeton
 * propre au poste ; seul son hash SHA-256 est stocké. Un 2e enregistrement du même
 * MachineGuid est refusé tant que la DSI n'a pas réinitialisé l'agent (token_hash NULL).
 */
export const deviceAgents = mysqlTable(
  'device_agents',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    /** Identité de l'agent : « MachineGuid|N° de série » (voir agentIdentity) */
    machineGuid: varchar('machine_guid', { length: 160 }).notNull(),
    deviceMigrationId: varchar('device_migration_id', { length: 36 }),
    tokenHash: varchar('token_hash', { length: 64 }),
    hostname: varchar('hostname', { length: 255 }),
    serialNumber: varchar('serial_number', { length: 100 }),
    agentVersion: varchar('agent_version', { length: 20 }),
    /** JSON DeviceAgentReport — dernier rapport reçu */
    report: mediumtext('report'),
    remoteIp: varchar('remote_ip', { length: 64 }),
    firstCheckinAt: timestamp('first_checkin_at').defaultNow().notNull(),
    lastCheckinAt: timestamp('last_checkin_at').defaultNow().notNull(),
  },
  (t) => ({
    uqMachine: uniqueIndex('uq_device_agents_machine').on(t.machineGuid),
    idxDevice: index('idx_device_agents_device').on(t.deviceMigrationId),
  })
)

export type DeviceAgentRow = typeof deviceAgents.$inferSelect

/**
 * PPKG Ouihelp (jeton de jonction en bloc), téléversé par la DSI. Un seul actif à la fois.
 * Contenu en base64 : quelques dizaines de Ko sans applications. Remis uniquement à un
 * agent authentifié dont le poste est en cours de bascule.
 */
export const deviceMigrationPackages = mysqlTable('device_migration_packages', {
  id: varchar('id', { length: 36 }).primaryKey(),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  sizeBytes: int('size_bytes').notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  content: mediumtext('content').notNull(),
  tokenExpiresAt: timestamp('token_expires_at'),
  uploadedBy: varchar('uploaded_by', { length: 255 }).notNull(),
  uploadedAt: timestamp('uploaded_at').defaultNow().notNull(),
  active: int('active').default(1).notNull(),
})

export type DeviceMigrationPackageRow = typeof deviceMigrationPackages.$inferSelect
