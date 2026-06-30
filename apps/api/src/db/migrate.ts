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
    { table: 'sync_status', column: 'sync_step', ddl: `ALTER TABLE \`sync_status\` ADD COLUMN \`sync_step\` varchar(100)` },
    { table: 'budget_items', column: 'billing_entity', ddl: `ALTER TABLE \`budget_items\` ADD COLUMN \`billing_entity\` enum('BALM','NHS','NHS PACA','ONELA Services','ONELA SAS','Colisee Domicile')` },
    { table: 'budget_items', column: 'quantity', ddl: `ALTER TABLE \`budget_items\` ADD COLUMN \`quantity\` int NOT NULL DEFAULT 1` },
    { table: 'budget_items', column: 'unit_cost', ddl: `ALTER TABLE \`budget_items\` ADD COLUMN \`unit_cost\` decimal(12,2)` },
    { table: 'sync_status', column: 'sync_progress', ddl: `ALTER TABLE \`sync_status\` ADD COLUMN \`sync_progress\` int NOT NULL DEFAULT 0` },
    { table: 'migrations', column: 'step_ou_move', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`step_ou_move\` enum('pending','running','success','error','skipped') NOT NULL DEFAULT 'pending'` },
    { table: 'migrations', column: 'ou_move_error', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`ou_move_error\` text` },
    // Sujet et date de réception pour les messages migrés (diagnostic erreurs)
    { table: 'migrated_messages', column: 'subject', ddl: `ALTER TABLE \`migrated_messages\` ADD COLUMN \`subject\` varchar(500)` },
    { table: 'migrated_messages', column: 'received_at', ddl: `ALTER TABLE \`migrated_messages\` ADD COLUMN \`received_at\` timestamp NULL` },
    // Shared mailbox : delta sync
    { table: 'shared_migrations', column: 'mail_last_sync_at', ddl: `ALTER TABLE \`shared_migrations\` ADD COLUMN \`mail_last_sync_at\` timestamp NULL` },
    // Shared mailbox : routing address override pour dual delivery
    { table: 'shared_migrations', column: 'dual_delivery_bcc_address', ddl: `ALTER TABLE \`shared_migrations\` ADD COLUMN \`dual_delivery_bcc_address\` varchar(320)` },
    // Migration users : suivi de l'activation du nouveau format prenom.nom@onela.com
    { table: 'migrations', column: 'step_new_format', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`step_new_format\` enum('pending','running','success','error','skipped') NOT NULL DEFAULT 'pending'` },
    { table: 'migrations', column: 'new_format_error', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`new_format_error\` text` },
    // SharePoint : fichiers ignorés (trop volumineux) + migration des versions
    { table: 'sharepoint_migrations', column: 'skipped_items', ddl: `ALTER TABLE \`sharepoint_migrations\` ADD COLUMN \`skipped_items\` int NOT NULL DEFAULT 0` },
    { table: 'sharepoint_migrations', column: 'migrate_versions', ddl: `ALTER TABLE \`sharepoint_migrations\` ADD COLUMN \`migrate_versions\` boolean NOT NULL DEFAULT true` },
    { table: 'sharepoint_migrations', column: 'selected_roots', ddl: `ALTER TABLE \`sharepoint_migrations\` ADD COLUMN \`selected_roots\` text` },
    // Sens du parcours mail ('desc' = récents d'abord par défaut, 'asc' = anciens d'abord)
    { table: 'migrations', column: 'mail_order', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`mail_order\` varchar(4) NOT NULL DEFAULT 'desc'` },
    // Plafond du run en jours (passe « anciens » bornée à J-N ; null = pas de plafond)
    { table: 'migrations', column: 'mail_before_days', ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`mail_before_days\` int` },
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

  // Conversions charset pour supporter les emojis (utf8mb4)
  const charsetPatches: Array<{ desc: string; ddl: string }> = [
    { desc: 'migrated_messages.subject → utf8mb4', ddl: `ALTER TABLE \`migrated_messages\` MODIFY COLUMN \`subject\` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci` },
    { desc: 'migrated_messages.error_details → utf8mb4', ddl: `ALTER TABLE \`migrated_messages\` MODIFY COLUMN \`error_details\` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci` },
  ]
  for (const p of charsetPatches) {
    try {
      await db.execute(sql.raw(p.ddl))
      console.log(`[migrate] Charset patch OK: ${p.desc}`)
    } catch (err) {
      console.error(`[migrate] Charset patch failed: ${p.desc} →`, err instanceof Error ? err.message : String(err))
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
    {
      table: 'shared_migrations',
      ddl: `CREATE TABLE \`shared_migrations\` (
        \`id\` varchar(36) NOT NULL,
        \`onela_user_id\` varchar(255) NOT NULL,
        \`onela_upn\` varchar(255) NOT NULL,
        \`onela_email\` varchar(255) NOT NULL,
        \`onela_display_name\` varchar(255) NOT NULL,
        \`target_group_email\` varchar(255) NOT NULL,
        \`target_group_name\` varchar(255) NOT NULL,
        \`target_group_id\` varchar(255),
        \`step_create_group\` enum('pending','running','success','error','skipped') NOT NULL DEFAULT 'pending',
        \`create_group_error\` text,
        \`step_mail_import\` enum('pending','running','success','error','skipped') NOT NULL DEFAULT 'pending',
        \`mail_total\` int NOT NULL DEFAULT 0,
        \`mail_migrated\` int NOT NULL DEFAULT 0,
        \`mail_failed\` int NOT NULL DEFAULT 0,
        \`mail_error\` text,
        \`mail_started_at\` timestamp NULL,
        \`mail_finished_at\` timestamp NULL,
        \`initiated_by\` varchar(255) NOT NULL,
        \`created_at\` timestamp NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        KEY \`idx_shared_step_mail\` (\`step_mail_import\`),
        KEY \`idx_shared_step_group\` (\`step_create_group\`)
      )`,
    },
    {
      table: 'shared_migrated_messages',
      ddl: `CREATE TABLE \`shared_migrated_messages\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`shared_migration_id\` varchar(36) NOT NULL,
        \`graph_message_id\` varchar(255) NOT NULL,
        \`internet_message_id\` varchar(1000),
        \`subject\` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        \`received_at\` timestamp NULL,
        \`status\` enum('success','error','skipped') NOT NULL,
        \`error_details\` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        \`created_at\` timestamp NOT NULL DEFAULT (now()),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`shared_migrated_messages_unique\` (\`shared_migration_id\`, \`graph_message_id\`),
        KEY \`idx_shared_msg_migration_id\` (\`shared_migration_id\`)
      )`,
    },
    {
      table: 'budget_items',
      ddl: `CREATE TABLE \`budget_items\` (
        \`id\` varchar(36) NOT NULL,
        \`name\` varchar(255) NOT NULL,
        \`vendor\` varchar(255),
        \`category\` enum('cloud','saas','hardware','license','support','telecom','other') NOT NULL DEFAULT 'other',
        \`quantity\` int NOT NULL DEFAULT 1,
        \`unit_cost\` decimal(12,2),
        \`amount\` decimal(12,2) NOT NULL DEFAULT 0,
        \`currency\` varchar(3) NOT NULL DEFAULT 'EUR',
        \`billing_cycle\` enum('monthly','quarterly','annual','one_time') NOT NULL DEFAULT 'annual',
        \`contract_start\` date,
        \`contract_end\` date,
        \`auto_renewal\` int NOT NULL DEFAULT 0,
        \`renewal_alert_days\` int NOT NULL DEFAULT 60,
        \`status\` enum('active','expiring_soon','expired','cancelled') NOT NULL DEFAULT 'active',
        \`billing_entity\` enum('BALM','NHS','NHS PACA','ONELA Services','ONELA SAS','Colisee Domicile'),
        \`notes\` text,
        \`created_at\` timestamp NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        KEY \`idx_budget_status\` (\`status\`),
        KEY \`idx_budget_category\` (\`category\`),
        KEY \`idx_budget_contract_end\` (\`contract_end\`)
      )`,
    },
    {
      table: 'onela_contacts',
      ddl: `CREATE TABLE \`onela_contacts\` (
        \`id\` varchar(36) NOT NULL,
        \`given_name\` varchar(255),
        \`family_name\` varchar(255),
        \`organization\` varchar(255),
        \`title\` varchar(255),
        \`email\` varchar(255) NOT NULL,
        \`phone\` varchar(64),
        \`created_at\` timestamp NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`onela_contacts_email_unique\` (\`email\`)
      )`,
    },
    {
      table: 'sharepoint_migrations',
      ddl: `CREATE TABLE \`sharepoint_migrations\` (
        \`id\` varchar(36) NOT NULL,
        \`site_url\` varchar(1000) NOT NULL,
        \`site_id\` varchar(500) NOT NULL,
        \`site_name\` varchar(500) NOT NULL,
        \`drive_id\` varchar(500) NOT NULL,
        \`drive_name\` varchar(500) NOT NULL,
        \`root_item_id\` varchar(500),
        \`root_path\` varchar(1000),
        \`selected_roots\` text,
        \`gd_shared_drive_id\` varchar(255),
        \`gd_shared_drive_name\` varchar(500) NOT NULL,
        \`status\` enum('pending','running','paused','success','error') NOT NULL DEFAULT 'pending',
        \`total_items\` int NOT NULL DEFAULT 0,
        \`migrated_items\` int NOT NULL DEFAULT 0,
        \`failed_items\` int NOT NULL DEFAULT 0,
        \`skipped_items\` int NOT NULL DEFAULT 0,
        \`total_bytes\` bigint NOT NULL DEFAULT 0,
        \`migrated_bytes\` bigint NOT NULL DEFAULT 0,
        \`migrate_versions\` boolean NOT NULL DEFAULT true,
        \`error_details\` text,
        \`started_at\` timestamp NULL,
        \`finished_at\` timestamp NULL,
        \`initiated_by\` varchar(255) NOT NULL,
        \`created_at\` timestamp NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        KEY \`idx_sp_migration_status\` (\`status\`)
      )`,
    },
    {
      table: 'sharepoint_migrated_items',
      ddl: `CREATE TABLE \`sharepoint_migrated_items\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`migration_id\` varchar(36) NOT NULL,
        \`sp_item_id\` varchar(500) NOT NULL,
        \`parent_sp_item_id\` varchar(500),
        \`name\` varchar(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        \`sp_path\` varchar(1500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        \`is_folder\` boolean NOT NULL DEFAULT false,
        \`size_bytes\` bigint,
        \`gd_file_id\` varchar(255),
        \`status\` enum('success','error','skipped') NOT NULL,
        \`error_details\` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
        \`created_at\` timestamp NOT NULL DEFAULT (now()),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`sharepoint_migrated_items_unique\` (\`migration_id\`, \`sp_item_id\`),
        KEY \`sharepoint_migrated_items_migration_idx\` (\`migration_id\`)
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
