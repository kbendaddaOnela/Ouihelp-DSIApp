import 'dotenv/config'
import { migrate } from 'drizzle-orm/mysql2/migrator'
import { db, pool } from './index'
import path from 'path'

export async function runMigrations() {
  const migrationsFolder = path.resolve(process.cwd(), 'drizzle')
  console.log('[migrate] Running migrations from', migrationsFolder)
  await migrate(db, { migrationsFolder })
  console.log('[migrate] Migrations done')
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
