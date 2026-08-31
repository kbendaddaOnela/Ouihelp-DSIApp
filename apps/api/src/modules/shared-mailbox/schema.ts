import { mysqlTable, varchar, mysqlEnum, timestamp, text, int, uniqueIndex } from 'drizzle-orm/mysql-core'

const stepStatus = ['pending', 'running', 'success', 'error', 'skipped'] as const
const messageStatus = ['success', 'error', 'skipped'] as const
const migrationMode = ['group', 'account'] as const

/**
 * Migration d'une boîte aux lettres partagée Exchange vers Google Workspace.
 * Indépendant du module migration ONELA standard (qui passe par un user GOH).
 *
 * DEUX MODES :
 *
 * - `account` (mode courant, seul créable) : la BAL devient un **compte Google
 *   classique** (`compta@mig.onela.com` + alias `compta@onela.com`) avec une
 *   licence Business Plus attribuée hors application (OU / console admin), et
 *   les personnes du service reçoivent une **délégation Gmail** dessus. Les
 *   mails sont importés dans la boîte Gmail du compte (dossiers → libellés),
 *   exactement comme pour un utilisateur nominatif.
 *   Pourquoi : les Google Groups (ancien mode) ne sont pas exploitables au
 *   quotidien par les collaborateurs ONELA (pas de vraie boîte, pas de
 *   brouillons partagés, ergonomie éloignée d'Outlook).
 *
 * - `group` (legacy) : archive d'un Google Group via l'API Groups Migration.
 *   Conservé pour l'historique et la relance des migrations déjà effectuées.
 */
export const sharedMigrations = mysqlTable('shared_migrations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  mode: mysqlEnum('mode', migrationMode).default('group').notNull(),
  // Source ONELA (boîte partagée Exchange)
  onelaUserId: varchar('onela_user_id', { length: 255 }).notNull(),
  onelaUpn: varchar('onela_upn', { length: 255 }).notNull(),
  onelaEmail: varchar('onela_email', { length: 255 }).notNull(),
  onelaDisplayName: varchar('onela_display_name', { length: 255 }).notNull(),

  // ── Cible « compte Google classique » (mode account) ──────────────────────
  /** Adresse primaire du compte, sur le domaine de transition (compta@mig.onela.com) */
  targetUserEmail: varchar('target_user_email', { length: 255 }),
  /** Alias définitif (compta@onela.com) — aussi l'adresse d'envoi par défaut */
  targetUserAlias: varchar('target_user_alias', { length: 255 }),
  targetDisplayName: varchar('target_display_name', { length: 255 }),
  targetUserId: varchar('target_user_id', { length: 255 }),
  /** Mot de passe généré à la création (jamais communiqué aux utilisateurs :
   *  l'accès se fait par délégation. Conservé pour le dépannage admin.) */
  targetPassword: varchar('target_password', { length: 255 }),
  stepCreateAccount: mysqlEnum('step_create_account', stepStatus).default('pending').notNull(),
  createAccountError: text('create_account_error'),
  /** Licence Business Plus : attribuée HORS application (OU ou console admin).
   *  L'étape est simplement acquittée depuis l'UI — l'import mail en dépend
   *  (sans licence Gmail, l'API d'import renvoie une erreur). */
  stepLicense: mysqlEnum('step_license', stepStatus).default('pending').notNull(),
  licenseAckAt: timestamp('license_ack_at'),
  licenseAckBy: varchar('license_ack_by', { length: 255 }),
  /** Alias onela.com + identité « Envoyer en tant que » par défaut */
  stepAliasSendAs: mysqlEnum('step_alias_send_as', stepStatus).default('pending').notNull(),
  aliasSendAsError: text('alias_send_as_error'),
  /** Délégations Gmail posées sur la boîte cible */
  stepDelegates: mysqlEnum('step_delegates', stepStatus).default('pending').notNull(),
  delegatesError: text('delegates_error'),

  // ── Cible « Google Group » (legacy) ───────────────────────────────────────
  targetGroupEmail: varchar('target_group_email', { length: 255 }),
  targetGroupName: varchar('target_group_name', { length: 255 }),
  targetGroupId: varchar('target_group_id', { length: 255 }),
  stepCreateGroup: mysqlEnum('step_create_group', stepStatus).default('pending').notNull(),
  createGroupError: text('create_group_error'),

  // ── Import mail (commun aux deux modes) ───────────────────────────────────
  stepMailImport: mysqlEnum('step_mail_import', stepStatus).default('pending').notNull(),
  mailTotal: int('mail_total').default(0).notNull(),
  mailMigrated: int('mail_migrated').default(0).notNull(),
  mailFailed: int('mail_failed').default(0).notNull(),
  mailError: text('mail_error'),
  mailStartedAt: timestamp('mail_started_at'),
  mailFinishedAt: timestamp('mail_finished_at'),
  // Horodatage du dernier succès complet — pour le delta sync au prochain Resync
  mailLastSyncAt: timestamp('mail_last_sync_at'),
  // Adresse de routage Google pour le BCC dual delivery. En mode `account` c'est
  // l'adresse primaire du compte (déjà sur mig.<domaine>), en mode `group` l'alias
  // mig.<domaine> posé sur le groupe.
  dualDeliveryBccAddress: varchar('dual_delivery_bcc_address', { length: 320 }),
  // Métadonnées
  initiatedBy: varchar('initiated_by', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
})

export type SharedMigration = typeof sharedMigrations.$inferSelect
export type NewSharedMigration = typeof sharedMigrations.$inferInsert

/**
 * Délégués Gmail de la boîte cible (mode account).
 *
 * Attention : le compte Exchange source et le compte Google ne portent PAS la
 * même adresse (pnom@onela.com côté Exchange vs prenom.nom@mig.onela.com côté
 * Google, avec l'alias prenom.nom@onela.com). On garde donc les deux : `sourceUpn`
 * pour la traçabilité du FullAccess Exchange, `googleEmail` (adresse PRIMAIRE
 * Google) pour l'appel à l'API de délégation.
 */
export const sharedMailboxDelegates = mysqlTable(
  'shared_mailbox_delegates',
  {
    id: int('id').autoincrement().primaryKey(),
    sharedMigrationId: varchar('shared_migration_id', { length: 36 }).notNull(),
    sourceUpn: varchar('source_upn', { length: 255 }),
    googleEmail: varchar('google_email', { length: 255 }).notNull(),
    displayName: varchar('display_name', { length: 255 }),
    status: mysqlEnum('status', stepStatus).default('pending').notNull(),
    errorDetails: text('error_details'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex('shared_mailbox_delegates_unique').on(t.sharedMigrationId, t.googleEmail),
  })
)

export type SharedMailboxDelegateRow = typeof sharedMailboxDelegates.$inferSelect

/** Suivi des messages déjà importés (idempotence + reprise) */
export const sharedMigratedMessages = mysqlTable(
  'shared_migrated_messages',
  {
    id: int('id').autoincrement().primaryKey(),
    sharedMigrationId: varchar('shared_migration_id', { length: 36 }).notNull(),
    graphMessageId: varchar('graph_message_id', { length: 255 }).notNull(),
    internetMessageId: varchar('internet_message_id', { length: 1000 }),
    /** Id du message dans Gmail (mode account uniquement — null en mode group) */
    gmailMessageId: varchar('gmail_message_id', { length: 255 }),
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
