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
const itemStatus = ['success', 'error', 'skipped'] as const

/**
 * Migration d'une bibliothèque (ou sous-dossier) d'un site SharePoint ONELA
 * vers un Google Shared Drive (Drive partagé) du Workspace OUIHELP/GOH.
 *
 * Indépendant du module migration utilisateur. Le worker `sharepoint-migration/worker.ts`
 * fait un parcours en largeur de l'arborescence : crée les dossiers Google d'abord
 * (mapping spFolderId → gdFolderId), puis transfère les fichiers.
 */
export const sharepointMigrations = mysqlTable('sharepoint_migrations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  // Source SharePoint
  siteUrl: varchar('site_url', { length: 1000 }).notNull(),
  siteId: varchar('site_id', { length: 500 }).notNull(),
  siteName: varchar('site_name', { length: 500 }).notNull(),
  driveId: varchar('drive_id', { length: 500 }).notNull(),
  driveName: varchar('drive_name', { length: 500 }).notNull(),
  // Sous-dossier source ; null = racine du drive (toute la bibliothèque)
  rootItemId: varchar('root_item_id', { length: 500 }),
  rootPath: varchar('root_path', { length: 1000 }),
  // Cible Google Shared Drive
  gdSharedDriveId: varchar('gd_shared_drive_id', { length: 255 }),
  gdSharedDriveName: varchar('gd_shared_drive_name', { length: 500 }).notNull(),
  // Statut global
  status: mysqlEnum('status', migrationStatus).default('pending').notNull(),
  // Compteurs (totalItems = fichiers découverts ; dossiers non comptés ici)
  totalItems: int('total_items').default(0).notNull(),
  migratedItems: int('migrated_items').default(0).notNull(),
  failedItems: int('failed_items').default(0).notNull(),
  totalBytes: bigint('total_bytes', { mode: 'number' }).default(0).notNull(),
  migratedBytes: bigint('migrated_bytes', { mode: 'number' }).default(0).notNull(),
  errorDetails: text('error_details'),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
  // Métadonnées
  initiatedBy: varchar('initiated_by', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
})

export type SharepointMigration = typeof sharepointMigrations.$inferSelect
export type NewSharepointMigration = typeof sharepointMigrations.$inferInsert

/**
 * Suivi des éléments (fichiers ET dossiers) déjà traités — idempotence + reprise.
 *
 * - Pour un dossier en success : `gdFileId` contient l'id du dossier Google créé
 *   → réutilisé comme parent des enfants au resume (pas de recréation).
 * - Pour un fichier en success : `gdFileId` contient l'id du fichier Google uploadé
 *   → skippé au resume.
 */
export const sharepointMigratedItems = mysqlTable(
  'sharepoint_migrated_items',
  {
    id: int('id').autoincrement().primaryKey(),
    migrationId: varchar('migration_id', { length: 36 }).notNull(),
    // Id du driveItem SharePoint (unique par migration → clé d'idempotence)
    spItemId: varchar('sp_item_id', { length: 500 }).notNull(),
    parentSpItemId: varchar('parent_sp_item_id', { length: 500 }),
    name: varchar('name', { length: 1000 }),
    spPath: varchar('sp_path', { length: 1500 }),
    isFolder: boolean('is_folder').default(false).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    // Id de l'objet Google créé (dossier ou fichier)
    gdFileId: varchar('gd_file_id', { length: 255 }),
    status: mysqlEnum('status', itemStatus).notNull(),
    errorDetails: text('error_details'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex('sharepoint_migrated_items_unique').on(t.migrationId, t.spItemId),
    byMigration: index('sharepoint_migrated_items_migration_idx').on(t.migrationId),
  })
)

export type SharepointMigratedItem = typeof sharepointMigratedItems.$inferSelect
export type NewSharepointMigratedItem = typeof sharepointMigratedItems.$inferInsert
