import { mysqlTable, varchar, mysqlEnum, timestamp, int, index } from 'drizzle-orm/mysql-core'

const userSource = ['ouihelp', 'onela', 'google'] as const
const deviceSource = ['ouihelp', 'onela'] as const
const complianceState = ['compliant', 'noncompliant', 'unknown', 'notApplicable', 'inGracePeriod', 'configManager'] as const

export const cachedUsers = mysqlTable(
  'cached_users',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    source: mysqlEnum('source', userSource).notNull(),
    upn: varchar('upn', { length: 255 }).notNull(),
    displayName: varchar('display_name', { length: 255 }),
    department: varchar('department', { length: 255 }),
    jobTitle: varchar('job_title', { length: 255 }),
    accountEnabled: int('account_enabled').default(1).notNull(),
    syncedAt: timestamp('synced_at').defaultNow().notNull(),
  },
  (t) => ({
    idxSource: index('idx_users_source').on(t.source),
    idxUpn: index('idx_users_upn').on(t.upn),
  })
)

export const cachedDevices = mysqlTable(
  'cached_devices',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    source: mysqlEnum('source', deviceSource).notNull(),
    deviceName: varchar('device_name', { length: 255 }),
    operatingSystem: varchar('operating_system', { length: 100 }),
    osVersion: varchar('os_version', { length: 100 }),
    deviceType: varchar('device_type', { length: 100 }),
    complianceState: mysqlEnum('compliance_state', complianceState).default('unknown').notNull(),
    userPrincipalName: varchar('user_principal_name', { length: 255 }),
    userDisplayName: varchar('user_display_name', { length: 255 }),
    lastSyncDateTime: timestamp('last_sync_date_time'),
    enrolledDateTime: timestamp('enrolled_date_time'),
    syncedAt: timestamp('synced_at').defaultNow().notNull(),
  },
  (t) => ({
    idxSource: index('idx_devices_source').on(t.source),
    idxCompliance: index('idx_devices_compliance').on(t.complianceState),
  })
)

export const syncStatus = mysqlTable('sync_status', {
  id: varchar('id', { length: 50 }).primaryKey(),
  lastSyncAt: timestamp('last_sync_at'),
  userCount: int('user_count').default(0).notNull(),
  deviceCount: int('device_count').default(0).notNull(),
  status: varchar('status', { length: 50 }).default('idle').notNull(),
  syncStep: varchar('sync_step', { length: 100 }),
  syncProgress: int('sync_progress').default(0).notNull(),
  error: varchar('error', { length: 500 }),
})

export type CachedUser = typeof cachedUsers.$inferSelect
export type CachedDevice = typeof cachedDevices.$inferSelect
