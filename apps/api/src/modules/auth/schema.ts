import { mysqlTable, varchar, mysqlEnum, timestamp } from 'drizzle-orm/mysql-core'

export const users = mysqlTable('users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 255 }).notNull(),
  tenantId: varchar('tenant_id', { length: 36 }).notNull(),
  role: mysqlEnum('role', ['admin', 'it_team', 'collaborator']).notNull().default('collaborator'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
})

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
