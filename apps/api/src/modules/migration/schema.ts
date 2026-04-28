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
