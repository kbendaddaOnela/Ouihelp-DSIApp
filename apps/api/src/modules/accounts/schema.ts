import { mysqlTable, varchar, mysqlEnum, timestamp, text } from 'drizzle-orm/mysql-core'

const stepStatus = ['pending', 'running', 'success', 'error', 'skipped'] as const
const assignmentType = ['Siège', 'Agence'] as const

/**
 * Création de comptes (onboarding nouvel arrivant ONELA).
 *
 * Flux tracé par étapes :
 *  1. stepCreateGoh       — création du compte GOH/Ouihelp (prenom.nom@mig.onela.com)
 *  2. stepSetAttributes   — ext10/ext11 + manager
 *  3. stepOnelaRouting    — MailContact Exchange ONELA (route onela.com → Google)
 *  4. stepGoogleProvision — détection SCIM (le compte remonte dans Google, 5-40 min)
 *  5. stepOuMove          — bascule sur l'OU /onela.com
 *  6. stepNewFormat       — alias prenom.nom@onela.com + send-as par défaut
 */
export const accountCreations = mysqlTable('account_creations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  // Identité
  firstName: varchar('first_name', { length: 255 }).notNull(),
  lastName: varchar('last_name', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  onelaUpn: varchar('onela_upn', { length: 255 }).notNull(),
  gohUpn: varchar('goh_upn', { length: 255 }).notNull(),
  gohUserId: varchar('goh_user_id', { length: 255 }),
  routingAddress: varchar('routing_address', { length: 255 }).notNull(),
  tempPassword: varchar('temp_password', { length: 255 }),
  // Affectation
  assignmentType: mysqlEnum('assignment_type', assignmentType).notNull(),
  department: varchar('department', { length: 255 }),
  jobTitle: varchar('job_title', { length: 255 }),
  managerUpn: varchar('manager_upn', { length: 255 }),
  officeLocation: varchar('office_location', { length: 255 }),
  state: varchar('state', { length: 255 }),
  streetAddress: varchar('street_address', { length: 500 }),
  postalCode: varchar('postal_code', { length: 20 }),
  city: varchar('city', { length: 255 }),
  // Étapes
  stepCreateGoh: mysqlEnum('step_create_goh', stepStatus).default('pending').notNull(),
  stepSetAttributes: mysqlEnum('step_set_attributes', stepStatus).default('pending').notNull(),
  stepOnelaRouting: mysqlEnum('step_onela_routing', stepStatus).default('pending').notNull(),
  stepGoogleProvision: mysqlEnum('step_google_provision', stepStatus).default('pending').notNull(),
  stepOuMove: mysqlEnum('step_ou_move', stepStatus).default('pending').notNull(),
  stepNewFormat: mysqlEnum('step_new_format', stepStatus).default('pending').notNull(),
  stepSendAs: mysqlEnum('step_send_as', stepStatus).default('pending').notNull(),
  errorDetails: text('error_details'),
  // Métadonnées
  initiatedBy: varchar('initiated_by', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
})

export type AccountCreation = typeof accountCreations.$inferSelect
export type NewAccountCreation = typeof accountCreations.$inferInsert

/**
 * Agences ONELA (référentiel éditable). Source de vérité pour le formulaire de
 * création (trigramme, région ONELA, adresse). Seedée depuis ONELA_AGENCIES au
 * premier démarrage si la table est vide.
 */
export const agencies = mysqlTable('agencies', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  trigramme: varchar('trigramme', { length: 20 }).notNull(),
  region: varchar('region', { length: 100 }).notNull(),
  address: varchar('address', { length: 500 }).notNull(),
  postalCode: varchar('postal_code', { length: 20 }).notNull(),
  city: varchar('city', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
})

export type Agency = typeof agencies.$inferSelect
export type NewAgency = typeof agencies.$inferInsert
