import 'dotenv/config'
import { migrate } from 'drizzle-orm/mysql2/migrator'
import { sql } from 'drizzle-orm'
import { db, pool } from './index'
import path from 'path'

// Hotfix : applique les changements de schéma critiques manquants au cas où Drizzle
// les aurait marqués comme appliqués sans que le SQL soit réellement exécuté.
async function ensureSchemaPatches() {
  const patches = [
    `ALTER TABLE \`migrations\` ADD COLUMN IF NOT EXISTS \`step_google_alias\` enum('pending','running','success','error','skipped') NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE \`migrations\` ADD COLUMN IF NOT EXISTS \`google_alias_error\` text`,
  ]
  for (const stmt of patches) {
    try {
      await db.execute(sql.raw(stmt))
      console.log('[migrate] Patch OK:', stmt.slice(0, 80))
    } catch (err) {
      console.error('[migrate] Patch failed:', stmt.slice(0, 80), '→', err instanceof Error ? err.message : String(err))
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
