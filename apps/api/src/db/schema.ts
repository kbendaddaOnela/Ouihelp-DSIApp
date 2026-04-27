import { mysqlTable, varchar, mysqlEnum, timestamp, text } from 'drizzle-orm/mysql-core'

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

const stepStatus = ['pending', 'running', 'success', 'error', 'skipped'] as const

export const migrations = mysqlTable('migrations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  // Source ONELA
  onelaUserId: varchar('onela_user_id', { length: 255 }).notNull(),
  onelaUpn: varchar('onela_upn', { length: 255 }).notNull(),
  onelaDisplayName: varchar('onela_display_name', { length: 255 }).notNull(),
  onelaEmail: varchar('onela_email', { length: 255 }).notNull(),
  onelaDepartment: varchar('onela_department', { length: 255 }),
  onelaJobTitle: varchar('onela_job_title', { length: 255 }),
  // Target GOH
  gohUserId: varchar('goh_user_id', { length: 255 }),
  gohUpn: varchar('goh_upn', { length: 255 }),
  tempPassword: varchar('temp_password', { length: 255 }),
  // Step statuses
  stepCreateAccount: mysqlEnum('step_create_account', stepStatus).default('pending').notNull(),
  stepSetAttributes: mysqlEnum('step_set_attributes', stepStatus).default('pending').notNull(),
  stepGroupMembership: mysqlEnum('step_group_membership', stepStatus).default('pending').notNull(),
  stepMailMigration: mysqlEnum('step_mail_migration', stepStatus).default('skipped').notNull(),
  // Metadata
  initiatedBy: varchar('initiated_by', { length: 255 }).notNull(),
  errorDetails: text('error_details'),
  exchangePsScript: text('exchange_ps_script'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
})

export type Migration = typeof migrations.$inferSelect
export type NewMigration = typeof migrations.$inferInsert
