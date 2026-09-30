import { mysqlTable, varchar, mysqlEnum, timestamp, text } from 'drizzle-orm/mysql-core'

/**
 * Journal des actions d'offboarding (départ d'un collaborateur).
 *
 * Pas de « dossier » d'offboarding à étapes pour l'instant : chaque action est
 * ponctuelle et tracée ici pour l'audit (qui a fait quoi sur quel compte).
 * Le mot de passe généré n'est JAMAIS stocké.
 */
export const offboardingActions = mysqlTable('offboarding_actions', {
  id: varchar('id', { length: 36 }).primaryKey(),
  targetEmail: varchar('target_email', { length: 255 }).notNull(),
  targetDisplayName: varchar('target_display_name', { length: 255 }),
  action: mysqlEnum('action', ['reset_password', 'add_delegate', 'remove_delegate']).notNull(),
  detail: varchar('detail', { length: 500 }),
  status: mysqlEnum('status', ['success', 'error']).notNull(),
  errorDetails: text('error_details'),
  initiatedBy: varchar('initiated_by', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export type OffboardingAction = typeof offboardingActions.$inferSelect
