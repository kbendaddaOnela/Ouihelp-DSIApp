import mysql from 'mysql2/promise'
import { drizzle } from 'drizzle-orm/mysql2'
import * as schema from './schema'

const pool = mysql.createPool({
  uri: process.env['DATABASE_URL'],
  ssl: { rejectUnauthorized: true },
  waitForConnections: true,
  connectionLimit: 5,
  timezone: 'Z',
})

export const db = drizzle(pool, { schema, mode: 'default' })
export { pool }
