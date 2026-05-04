import 'dotenv/config'
import { migrate } from 'drizzle-orm/mysql2/migrator'
import { sql } from 'drizzle-orm'
import { db, pool } from './index'
import path from 'path'

// Hotfix : applique les changements de schéma critiques manquants au cas où Drizzle
// les aurait marqués comme appliqués sans que le SQL soit réellement exécuté.
async function columnExists(table: string, column: string): Promise<boolean> {
  const [rows] = (await pool.query(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  )) as [Array<unknown>, unknown]
  return rows.length > 0
}

async function tableExists(table: string): Promise<boolean> {
  const [rows] = (await pool.query(
    `SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [table]
  )) as [Array<unknown>, unknown]
  return rows.length > 0
}

async function ensureSchemaPatches() {
  // Colonnes à ajouter sur la table migrations
  const columnPatches: Array<{ table: string; column: string; ddl: string }> = [
    { table: 'migrations', column: 'step_google_alias', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`step_google_alias\` enum('pending','running','success','error','skipped') NOT NULL DEFAULT 'pending'` },
    { table: 'migrations', column: 'google_alias_error', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`google_alias_error\` text` },
    { table: 'migrations', column: 'mail_total', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`mail_total\` int NOT NULL DEFAULT 0` },
    { table: 'migrations', column: 'mail_migrated', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`mail_migrated\` int NOT NULL DEFAULT 0` },
    { table: 'migrations', column: 'mail_failed', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`mail_failed\` int NOT NULL DEFAULT 0` },
    { table: 'migrations', column: 'mail_error', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`mail_error\` text` },
    { table: 'migrations', column: 'mail_started_at', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`mail_started_at\` timestamp NULL` },
    { table: 'migrations', column: 'mail_finished_at', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`mail_finished_at\` timestamp NULL` },
    // Calendar
    { table: 'migrations', column: 'step_calendar_migration', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`step_calendar_migration\` enum('pending','running','success','error','skipped') NOT NULL DEFAULT 'pending'` },
    { table: 'migrations', column: 'cal_total', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`cal_total\` int NOT NULL DEFAULT 0` },
    { table: 'migrations', column: 'cal_migrated', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`cal_migrated\` int NOT NULL DEFAULT 0` },
    { table: 'migrations', column: 'cal_failed', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`cal_failed\` int NOT NULL DEFAULT 0` },
    { table: 'migrations', column: 'cal_error', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`cal_error\` text` },
    { table: 'migrations', column: 'cal_started_at', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`cal_started_at\` timestamp NULL` },
    { table: 'migrations', column: 'cal_finished_at', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`cal_finished_at\` timestamp NULL` },
    // Contacts
    { table: 'migrations', column: 'step_contacts_migration', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`step_contacts_migration\` enum('pending','running','success','error','skipped') NOT NULL DEFAULT 'pending'` },
    { table: 'migrations', column: 'contacts_total', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`contacts_total\` int NOT NULL DEFAULT 0` },
    { table: 'migrations', column: 'contacts_migrated', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`contacts_migrated\` int NOT NULL DEFAULT 0` },
    { table: 'migrations', column: 'contacts_failed', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`contacts_failed\` int NOT NULL DEFAULT 0` },
    { table: 'migrations', column: 'contacts_error', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`contacts_error\` text` },
    { table: 'migrations', column: 'contacts_started_at', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`contacts_started_at\` timestamp NULL` },
    { table: 'migrations', column: 'contacts_finished_at', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`contacts_finished_at\` timestamp NULL` },
    // Delta sync timestamps
    { table: 'migrations', column: 'mail_last_sync_at', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`mail_last_sync_at\` timestamp NULL` },
    { table: 'migrations', column: 'cal_last_sync_at', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`cal_last_sync_at\` timestamp NULL` },
    { table: 'migrations', column: 'contacts_last_sync_at', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`contacts_last_sync_at\` timestamp NULL` },
    { table: 'migrations', column: 'archived', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`archived\` int NOT NULL DEFAULT 0` },
    { table: 'migrations', column: 'archived_at', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`archived_at\` timestamp NULL` },
  ]
  for (const p of columnPatches) {
    try {
      if (await columnExists(p.table, p.column)) {
        console.log(`[migrate] Patch skipped (column exists): ${p.table}.${p.column}`)
        continue
      }
      await db.execute(sql.raw(p.ddl))
      console.log(`[migrate] Patch OK: ${p.table}.${p.column}`)
    } catch (err) {
      console.error(`[migrate] Patch failed: ${p.table}.${p.column} →`, err instanceof Error ? err.message : String(err))
    }
  }

  // Tables à créer
  const tablePatches: Array<{ table: string; ddl: string }> = [
    {
      table: 'migrated_messages',
      ddl: `CREATE TABLE \`migrated_messages\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`migration_id\` varchar(36) NOT NULL,
        \`graph_message_id\` varchar(255) NOT NULL,
        \`internet_message_id\` varchar(1000),
        \`gmail_message_id\` varchar(255),
        \`status\` enum('success','error','skipped') NOT NULL,
        \`error_details\` text,
        \`created_at\` timestamp NOT NULL DEFAULT (now()),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`migrated_messages_unique\` (\`migration_id\`, \`graph_message_id\`),
        KEY \`idx_migration_id\` (\`migration_id\`)
      )`,
    },
    {
      table: 'migrated_events',
      ddl: `CREATE TABLE \`migrated_events\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`migration_id\` varchar(36) NOT NULL,
        \`graph_event_id\` varchar(255) NOT NULL,
        \`ical_uid\` varchar(1000),
        \`google_event_id\` varchar(1024),
        \`status\` enum('success','error','skipped') NOT NULL,
        \`error_details\` text,
        \`created_at\` timestamp NOT NULL DEFAULT (now()),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`migrated_events_unique\` (\`migration_id\`, \`graph_event_id\`),
        KEY \`idx_event_migration_id\` (\`migration_id\`)
      )`,
    },
    {
      table: 'migrated_contacts',
      ddl: `CREATE TABLE \`migrated_contacts\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`migration_id\` varchar(36) NOT NULL,
        \`graph_contact_id\` varchar(255) NOT NULL,
        \`google_resource_name\` varchar(255),
        \`status\` enum('success','error','skipped') NOT NULL,
        \`error_details\` text,
        \`created_at\` timestamp NOT NULL DEFAULT (now()),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`migrated_contacts_unique\` (\`migration_id\`, \`graph_contact_id\`),
        KEY \`idx_contact_migration_id\` (\`migration_id\`)
      )`,
    },
    {
      table: 'migration_targets',
      ddl: `CREATE TABLE \`migration_targets\` (
        \`id\` varchar(36) NOT NULL,
        \`onela_upn\` varchar(255) NOT NULL,
        \`display_name\` varchar(255) NOT NULL,
        \`department\` varchar(255),
        \`office\` varchar(255),
        \`status\` enum('pending','in_progress','done') NOT NULL DEFAULT 'pending',
        \`migration_id\` varchar(36),
        \`created_at\` timestamp NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`migration_targets_upn_unique\` (\`onela_upn\`),
        KEY \`idx_target_status\` (\`status\`),
        KEY \`idx_target_department\` (\`department\`),
        KEY \`idx_target_office\` (\`office\`)
      )`,
    },
  ]
    {
      table: 'cached_users',
      ddl: `CREATE TABLE \`cached_users\` (
        \`id\` varchar(36) NOT NULL,
        \`source\` enum('ouihelp','onela','google') NOT NULL,
        \`upn\` varchar(255) NOT NULL,
        \`display_name\` varchar(255),
        \`department\` varchar(255),
        \`job_title\` varchar(255),
        \`account_enabled\` int NOT NULL DEFAULT 1,
        \`synced_at\` timestamp NOT NULL DEFAULT (now()),
        PRIMARY KEY (\`id\`),
        KEY \`idx_users_source\` (\`source\`),
        KEY \`idx_users_upn\` (\`upn\`)
      )`,
    },
    {
      table: 'cached_devices',
      ddl: `CREATE TABLE \`cached_devices\` (
        \`id\` varchar(36) NOT NULL,
        \`source\` enum('ouihelp','onela') NOT NULL,
        \`device_name\` varchar(255),
        \`operating_system\` varchar(100),
        \`os_version\` varchar(100),
        \`device_type\` varchar(100),
        \`compliance_state\` enum('compliant','noncompliant','unknown','notApplicable','inGracePeriod','configManager') NOT NULL DEFAULT 'unknown',
        \`user_principal_name\` varchar(255),
        \`user_display_name\` varchar(255),
        \`last_sync_date_time\` timestamp NULL,
        \`enrolled_date_time\` timestamp NULL,
        \`synced_at\` timestamp NOT NULL DEFAULT (now()),
        PRIMARY KEY (\`id\`),
        KEY \`idx_devices_source\` (\`source\`),
        KEY \`idx_devices_compliance\` (\`compliance_state\`)
      )`,
    },
    {
      table: 'sync_status',
      ddl: `CREATE TABLE \`sync_status\` (
        \`id\` varchar(50) NOT NULL,
        \`last_sync_at\` timestamp NULL,
        \`user_count\` int NOT NULL DEFAULT 0,
        \`device_count\` int NOT NULL DEFAULT 0,
        \`status\` varchar(50) NOT NULL DEFAULT 'idle',
        \`error\` varchar(500),
        PRIMARY KEY (\`id\`)
      )`,
    },
  ]
  for (const p of tablePatches) {
    try {
      if (await tableExists(p.table)) {
        console.log(`[migrate] Patch skipped (table exists): ${p.table}`)
        continue
      }
      await db.execute(sql.raw(p.ddl))
      console.log(`[migrate] Patch OK: table ${p.table}`)
    } catch (err) {
      console.error(`[migrate] Patch failed: table ${p.table} →`, err instanceof Error ? err.message : String(err))
    }
  }
}

export async function runMigrations() {
  const migrationsFolder = path.resolve(process.cwd(), 'drizzle')
  console.log('[migrate] Running migrations from', migrationsFolder)
  try {
    await migrate(db, { migrationsFolder })
    console.log('[migrate] Migrations done')
  } catch (err) {
    console.error('[migrate] Error:', err instanceof Error ? err.message : String(err))
    throw err
  }
  await ensureSchemaPatches()
}

// Permet d'exécuter ce fichier directement : node dist/migrate.js
if (process.argv[1]?.endsWith('migrate.js') || process.argv[1]?.endsWith('migrate.ts')) {
  runMigrations()
    .then(() => pool.end())
    .catch((err) => {
      console.error('[migrate] Failed:', err)
      process.exit(1)
    })
}
