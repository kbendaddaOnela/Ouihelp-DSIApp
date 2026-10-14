import { mysqlTable, varchar, mysqlEnum, timestamp, int, text, index, uniqueIndex } from 'drizzle-orm/mysql-core'

const joinType = ['entra_joined', 'hybrid', 'registered', 'unknown'] as const

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
    isEncrypted: int('is_encrypted'),
    freeStorageGb: int('free_storage_gb'),
    totalStorageGb: int('total_storage_gb'),
    bitlockerKeysOnela: int('bitlocker_keys_onela'),

    ouihelpIntuneId: varchar('ouihelp_intune_id', { length: 36 }),
    ouihelpEntraDeviceId: varchar('ouihelp_entra_device_id', { length: 36 }),
    ouihelpAutopilotId: varchar('ouihelp_autopilot_id', { length: 64 }),
    ouihelpLastSync: timestamp('ouihelp_last_sync'),
    ouihelpUserUpn: varchar('ouihelp_user_upn', { length: 255 }),

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
