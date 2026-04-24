import mysql from 'mysql2/promise'
import { drizzle } from 'drizzle-orm/mysql2'
import * as schema from './schema'

let _pool: mysql.Pool | null = null
let _db: ReturnType<typeof drizzle> | null = null

function getPool(): mysql.Pool {
  if (!_pool) {
    const uri = process.env['DATABASE_URL']
    if (!uri) throw new Error('DATABASE_URL non défini')
    _pool = mysql.createPool({
      uri,
      ssl: { rejectUnauthorized: false },
      waitForConnections: true,
      connectionLimit: 5,
      timezone: 'Z',
    })
  }
  return _pool
}

export function getDb() {
  if (!_db) _db = drizzle(getPool(), { schema, mode: 'default' })
  return _db
}

// Compatibilité : export nommé pour les imports existants
export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get: (_t, prop) => getDb()[prop as keyof ReturnType<typeof drizzle>],
})

export const pool = new Proxy({} as mysql.Pool, {
  get: (_t, prop) => getPool()[prop as keyof mysql.Pool],
})
