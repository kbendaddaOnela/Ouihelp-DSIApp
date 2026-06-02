import { mysqlTable, varchar, mysqlEnum, timestamp, text, int, uniqueIndex } from 'drizzle-orm/mysql-core'

const stepStatus = ['pending', 'running', 'success', 'error', 'skipped'] as const
const messageStatus = ['success', 'error', 'skipped'] as const

/**
 * Migration d'une boîte aux lettres partagée Exchange → archive d'un Google Group.
 * Indépendant du module migration ONELA standard (qui passe par un user GOH).
 *
 * Pourquoi un Google Group : pour ne pas consommer de licence Workspace.
 * L'import se fait via l'API Google Groups Migration (apps.groups.migration)
 * qui préserve la date d'origine des messages dans l'archive du groupe.
 */
export const sharedMigrations = mysqlTable('shared_migrations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  // Source ONELA (boîte partagée Exchange)
  onelaUserId: varchar('onela_user_id', { length: 255 }).notNull(),
  onelaUpn: varchar('onela_upn', { length: 255 }).notNull(),
  onelaEmail: varchar('onela_email', { length: 255 }).notNull(),
  onelaDisplayName: varchar('onela_display_name', { length: 255 }).notNull(),
  // Cible Google Group
  targetGroupEmail: varchar('target_group_email', { length: 255 }).notNull(),
  targetGroupName: varchar('target_group_name', { length: 255 }).notNull(),
  targetGroupId: varchar('target_group_id', { length: 255 }),
  // Étapes
  stepCreateGroup: mysqlEnum('step_create_group', stepStatus).default('pending').notNull(),
  createGroupError: text('create_group_error'),
  stepMailImport: mysqlEnum('step_mail_import', stepStatus).default('pending').notNull(),
  // Compteurs mail
  mailTotal: int('mail_total').default(0).notNull(),
  mailMigrated: int('mail_migrated').default(0).notNull(),
  mailFailed: int('mail_failed').default(0).notNull(),
  mailError: text('mail_error'),
  mailStartedAt: timestamp('mail_started_at'),
  mailFinishedAt: timestamp('mail_finished_at'),
  // Horodatage du dernier succès complet — pour le delta sync au prochain Resync
  mailLastSyncAt: timestamp('mail_last_sync_at'),
  // Adresse de routage Google pour le BCC dual delivery (override possible si
  // le test-google-a.com du domaine secondaire ne marche pas ; sinon calculé auto)
  dualDeliveryBccAddress: varchar('dual_delivery_bcc_address', { length: 320 }),
  // Métadonnées
  initiatedBy: varchar('initiated_by', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
})

export type SharedMigration = typeof sharedMigrations.$inferSelect
export type NewSharedMigration = typeof sharedMigrations.$inferInsert

/** Suivi des messages déjà importés dans le groupe (idempotence + reprise) */
export const sharedMigratedMessages = mysqlTable(
  'shared_migrated_messages',
  {
    id: int('id').autoincrement().primaryKey(),
    sharedMigrationId: varchar('shared_migration_id', { length: 36 }).notNull(),
    graphMessageId: varchar('graph_message_id', { length: 255 }).notNull(),
    internetMessageId: varchar('internet_message_id', { length: 1000 }),
    subject: varchar('subject', { length: 500 }),
    receivedAt: timestamp('received_at'),
    status: mysqlEnum('status', messageStatus).notNull(),
    errorDetails: text('error_details'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex('shared_migrated_messages_unique').on(t.sharedMigrationId, t.graphMessageId),
  })
)

export type SharedMigratedMessage = typeof sharedMigratedMessages.$inferSelect
