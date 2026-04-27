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

async function ensureSchemaPatches() {
  const patches: Array<{ table: string; column: string; ddl: string }> = [
    {
      table: 'migrations',
      column: 'step_google_alias',
      ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`step_google_alias\` enum('pending','running','success','error','skipped') NOT NULL DEFAULT 'pending'`,
    },
    {
      table: 'migrations',
      column: 'google_alias_error',
      ddl: `ALTER TABLE \`migrations\` ADD COLUMN \`google_alias_error\` text`,
    },
  ]
  for (const p of patches) {
    try {
      const exists = await columnExists(p.table, p.column)
      if (exists) {
        console.log(`[migrate] Patch skipped (column exists): ${p.table}.${p.column}`)
        continue
      }
      await db.execute(sql.raw(p.ddl))
      console.log(`[migrate] Patch OK: ${p.table}.${p.column}`)
    } catch (err) {
      console.error(`[migrate] Patch failed: ${p.table}.${p.column} →`, err instanceof Error ? err.message : String(err))
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
