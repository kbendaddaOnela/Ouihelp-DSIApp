import {
  mysqlTable,
  varchar,
  mysqlEnum,
  timestamp,
  text,
  int,
  bigint,
  boolean,
  uniqueIndex,
  index,
} from 'drizzle-orm/mysql-core'

const migrationStatus = ['pending', 'running', 'paused', 'success', 'error'] as const
const stepStatus = ['pending', 'running', 'success', 'error', 'skipped'] as const
// 'deleted' n'existe pas dans le module Drive : ici la source peut supprimer,
// et la ligne doit rester (trace + évite de re-créer l'item à la passe suivante).
const itemStatus = ['success', 'error', 'skipped', 'deleted'] as const

/**
 * Migration d'un site SharePoint d'agence ONELA vers un site SharePoint Ouihelp.
 *
 * Une ligne = un site source ↔ un site cible. La granularité « site » est
 * volontaire : c'est l'unité que Ximi manipule (une URL par agence), et c'est
 * elle qui apparaît dans le tableau de mappage exporté.
 */
export const ximiMigrations = mysqlTable('ximi_migrations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  label: varchar('label', { length: 200 }),

  // ── Source (tenant ONELA) ──────────────────────────────────────────────────
  sourceSiteUrl: varchar('source_site_url', { length: 1000 }).notNull(),
  sourceSiteId: varchar('source_site_id', { length: 500 }).notNull(),
  sourceSiteName: varchar('source_site_name', { length: 500 }).notNull(),
  // Bibliothèque par défaut du site source, résolue au premier run.
  sourceDriveId: varchar('source_drive_id', { length: 500 }),
  sourceDriveName: varchar('source_drive_name', { length: 500 }),

  // ── Cible (tenant Ouihelp) ─────────────────────────────────────────────────
  targetSiteUrl: varchar('target_site_url', { length: 1000 }),
  targetSiteId: varchar('target_site_id', { length: 500 }),
  targetSiteName: varchar('target_site_name', { length: 500 }),
  // Alias d'URL demandé (/sites/<alias>) ; conservé même si la création échoue,
  // pour pouvoir rejouer sans ressaisie.
  targetSiteAlias: varchar('target_site_alias', { length: 200 }),
  targetDriveId: varchar('target_drive_id', { length: 500 }),
  // Site cible fourni par l'opérateur (déjà créé à la main) → on ne crée rien.
  targetPreexisting: boolean('target_preexisting').default(false).notNull(),
  siteStatus: mysqlEnum('site_status', stepStatus).default('pending').notNull(),
  siteError: text('site_error'),

  // ── Droits : groupe dynamique d'agence (tenant Ouihelp) ────────────────────
  dynamicGroupName: varchar('dynamic_group_name', { length: 300 }),
  dynamicGroupId: varchar('dynamic_group_id', { length: 100 }),
  permissionStatus: mysqlEnum('permission_status', stepStatus).default('pending').notNull(),
  permissionError: text('permission_error'),

  // ── Transfert ──────────────────────────────────────────────────────────────
  status: mysqlEnum('status', migrationStatus).default('pending').notNull(),
  analyzeOnly: boolean('analyze_only').default(false).notNull(),
  totalItems: int('total_items').default(0).notNull(),
  migratedItems: int('migrated_items').default(0).notNull(),
  updatedItems: int('updated_items').default(0).notNull(),
  // Items supprimés côté source et répercutés côté cible (corbeille SharePoint).
  deletedItems: int('deleted_items').default(0).notNull(),
  // Items renommés ou déplacés côté source et répercutés côté cible.
  movedItems: int('moved_items').default(0).notNull(),
  failedItems: int('failed_items').default(0).notNull(),
  skippedItems: int('skipped_items').default(0).notNull(),
  scannedItems: int('scanned_items').default(0).notNull(),
  totalBytes: bigint('total_bytes', { mode: 'number' }).default(0).notNull(),
  migratedBytes: bigint('migrated_bytes', { mode: 'number' }).default(0).notNull(),
  processedBytes: bigint('processed_bytes', { mode: 'number' }).default(0).notNull(),

  /**
   * Jeton delta Graph de la dernière passe RÉUSSIE.
   *
   * C'est la pièce maîtresse du module : tant qu'il est null, la passe est une
   * énumération complète (pré-migration) ; dès qu'il est posé, la passe suivante
   * ne reçoit que les changements — y compris les SUPPRESSIONS et les
   * DÉPLACEMENTS, que la comparaison de dates du module Drive ne peut pas voir.
   *
   * Il n'est enregistré qu'à la fin d'une passe complète : une passe interrompue
   * repart d'une énumération complète (idempotente grâce à ximi_migrated_items)
   * plutôt que de sauter des changements.
   */
  deltaToken: text('delta_token'),
  lastDeltaAt: timestamp('last_delta_at'),

  errorDetails: text('error_details'),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
  archived: int('archived').default(0).notNull(),
  archivedAt: timestamp('archived_at'),
  initiatedBy: varchar('initiated_by', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
})

export type XimiMigration = typeof ximiMigrations.$inferSelect
export type NewXimiMigration = typeof ximiMigrations.$inferInsert

/**
 * Correspondance item source ↔ item cible. Sert à trois choses :
 *  1. idempotence / reprise (comme le module Drive) ;
 *  2. résolution du PARENT cible lors d'une création (le delta donne l'id du
 *     parent SOURCE, il faut le traduire) ;
 *  3. répercussion des suppressions et des déplacements : sans cette table on
 *     ne saurait pas QUEL item cible correspond à l'item source supprimé.
 */
export const ximiMigratedItems = mysqlTable(
  'ximi_migrated_items',
  {
    id: int('id').autoincrement().primaryKey(),
    migrationId: varchar('migration_id', { length: 36 }).notNull(),
    spItemId: varchar('sp_item_id', { length: 500 }).notNull(),
    parentSpItemId: varchar('parent_sp_item_id', { length: 500 }),
    name: varchar('name', { length: 1000 }),
    spPath: varchar('sp_path', { length: 1500 }),
    isFolder: boolean('is_folder').default(false).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** Id du driveItem créé côté Ouihelp */
    targetItemId: varchar('target_item_id', { length: 500 }),
    status: mysqlEnum('status', itemStatus).notNull(),
    errorDetails: text('error_details'),
    /** Date de dernière modification côté source AU MOMENT du transfert */
    spLastModified: timestamp('sp_last_modified'),
    /** Instant où la passe courante a touché cet item */
    syncedAt: timestamp('synced_at'),
    /** Instant de la répercussion d'une suppression source (status='deleted') */
    deletedAt: timestamp('deleted_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex('ximi_migrated_items_unique').on(t.migrationId, t.spItemId),
    byMigration: index('ximi_migrated_items_migration_idx').on(t.migrationId),
  })
)

export type XimiMigratedItem = typeof ximiMigratedItems.$inferSelect
export type NewXimiMigratedItem = typeof ximiMigratedItems.$inferInsert
