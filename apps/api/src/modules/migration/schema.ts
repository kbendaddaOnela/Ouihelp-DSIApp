import { mysqlTable, varchar, mysqlEnum, timestamp, text, int, uniqueIndex } from 'drizzle-orm/mysql-core'

const stepStatus = ['pending', 'running', 'success', 'error', 'skipped'] as const
const messageStatus = ['success', 'error', 'skipped'] as const

export const migrations = mysqlTable('migrations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  // Source ONELA
  onelaUserId: varchar('onela_user_id', { length: 255 }).notNull(),
  onelaUpn: varchar('onela_upn', { length: 255 }).notNull(),
  onelaDisplayName: varchar('onela_display_name', { length: 255 }).notNull(),
  onelaEmail: varchar('onela_email', { length: 255 }).notNull(),
  onelaDepartment: varchar('onela_department', { length: 255 }),
  onelaJobTitle: varchar('onela_job_title', { length: 255 }),
  // Target GOH
  gohUserId: varchar('goh_user_id', { length: 255 }),
  gohUpn: varchar('goh_upn', { length: 255 }),
  tempPassword: varchar('temp_password', { length: 255 }),
  // Step statuses
  stepCreateAccount: mysqlEnum('step_create_account', stepStatus).default('pending').notNull(),
  stepSetAttributes: mysqlEnum('step_set_attributes', stepStatus).default('pending').notNull(),
  stepGroupMembership: mysqlEnum('step_group_membership', stepStatus).default('pending').notNull(),
  stepMailMigration: mysqlEnum('step_mail_migration', stepStatus).default('skipped').notNull(),
  stepGoogleAlias: mysqlEnum('step_google_alias', stepStatus).default('pending').notNull(),
  googleAliasError: text('google_alias_error'),
  // Mail migration progress (Phase B)
  mailTotal: int('mail_total').default(0).notNull(),
  mailMigrated: int('mail_migrated').default(0).notNull(),
  mailFailed: int('mail_failed').default(0).notNull(),
  mailError: text('mail_error'),
  mailStartedAt: timestamp('mail_started_at'),
  mailFinishedAt: timestamp('mail_finished_at'),
  mailLastSyncAt: timestamp('mail_last_sync_at'),
  // Calendar migration progress
  stepCalendarMigration: mysqlEnum('step_calendar_migration', stepStatus).default('pending').notNull(),
  calTotal: int('cal_total').default(0).notNull(),
  calMigrated: int('cal_migrated').default(0).notNull(),
  calFailed: int('cal_failed').default(0).notNull(),
  calError: text('cal_error'),
  calStartedAt: timestamp('cal_started_at'),
  calFinishedAt: timestamp('cal_finished_at'),
  calLastSyncAt: timestamp('cal_last_sync_at'),
  // Contacts migration progress
  stepContactsMigration: mysqlEnum('step_contacts_migration', stepStatus).default('pending').notNull(),
  contactsTotal: int('contacts_total').default(0).notNull(),
  contactsMigrated: int('contacts_migrated').default(0).notNull(),
  contactsFailed: int('contacts_failed').default(0).notNull(),
  contactsError: text('contacts_error'),
  contactsStartedAt: timestamp('contacts_started_at'),
  contactsFinishedAt: timestamp('contacts_finished_at'),
  contactsLastSyncAt: timestamp('contacts_last_sync_at'),
  // Archivage
  archived: int('archived').default(0).notNull(), // 0 = actif, 1 = archivé (boolean)
  archivedAt: timestamp('archived_at'),
  // Metadata
  initiatedBy: varchar('initiated_by', { length: 255 }).notNull(),
  errorDetails: text('error_details'),
  exchangePsScript: text('exchange_ps_script'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
})

export type Migration = typeof migrations.$inferSelect
export type NewMigration = typeof migrations.$inferInsert

// ── Suivi des messages migrés (idempotence + reprise) ─────────────────────────
export const migratedMessages = mysqlTable(
  'migrated_messages',
  {
    id: int('id').autoincrement().primaryKey(),
    migrationId: varchar('migration_id', { length: 36 }).notNull(),
    graphMessageId: varchar('graph_message_id', { length: 255 }).notNull(),
    internetMessageId: varchar('internet_message_id', { length: 1000 }),
    gmailMessageId: varchar('gmail_message_id', { length: 255 }),
    status: mysqlEnum('status', messageStatus).notNull(),
    errorDetails: text('error_details'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex('migrated_messages_unique').on(t.migrationId, t.graphMessageId),
  })
)

export type MigratedMessage = typeof migratedMessages.$inferSelect

// ── Suivi des events calendrier migrés ───────────────────────────────────────
export const migratedEvents = mysqlTable(
  'migrated_events',
  {
    id: int('id').autoincrement().primaryKey(),
    migrationId: varchar('migration_id', { length: 36 }).notNull(),
    graphEventId: varchar('graph_event_id', { length: 255 }).notNull(),
    iCalUid: varchar('ical_uid', { length: 1000 }),
    googleEventId: varchar('google_event_id', { length: 1024 }),
    status: mysqlEnum('status', messageStatus).notNull(),
    errorDetails: text('error_details'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex('migrated_events_unique').on(t.migrationId, t.graphEventId),
  })
)
export type MigratedEvent = typeof migratedEvents.$inferSelect

// ── Suivi des contacts migrés ────────────────────────────────────────────────
export const migratedContacts = mysqlTable(
  'migrated_contacts',
  {
    id: int('id').autoincrement().primaryKey(),
    migrationId: varchar('migration_id', { length: 36 }).notNull(),
    graphContactId: varchar('graph_contact_id', { length: 255 }).notNull(),
    googleResourceName: varchar('google_resource_name', { length: 255 }),
    status: mysqlEnum('status', messageStatus).notNull(),
    errorDetails: text('error_details'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex('migrated_contacts_unique').on(t.migrationId, t.graphContactId),
  })
)
export type MigratedContact = typeof migratedContacts.$inferSelect

// ── Liste cible de migration (importée depuis CSV) ───────────────────────────
const targetStatus = ['pending', 'in_progress', 'done'] as const

export const migrationTargets = mysqlTable(
  'migration_targets',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    onelaUpn: varchar('onela_upn', { length: 255 }).notNull(),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    department: varchar('department', { length: 255 }),
    office: varchar('office', { length: 255 }),
    status: mysqlEnum('status', targetStatus).default('pending').notNull(),
    migrationId: varchar('migration_id', { length: 36 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex('migration_targets_upn_unique').on(t.onelaUpn),
  })
)

export type MigrationTarget = typeof migrationTargets.$inferSelect
