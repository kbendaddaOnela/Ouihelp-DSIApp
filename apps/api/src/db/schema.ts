// Schéma Drizzle ORM — Phase 1 : structure initiale
// Les migrations seront générées en Phase 2 lors du branchement Supabase

// Note : les imports Drizzle sont commentés car la dépendance sera ajoutée en Phase 2
// import { pgTable, text, timestamp, pgEnum } from 'drizzle-orm/pg-core'

// Enum des rôles (mirroir de packages/shared/types/roles.ts)
// export const roleEnum = pgEnum('role', ['admin', 'it_team', 'collaborator'])

// Table users — lien entre OID Microsoft et rôle applicatif
// export const users = pgTable('users', {
//   id: text('id').primaryKey(),             // OID Microsoft Entra ID
//   email: text('email').notNull().unique(),
//   name: text('name').notNull(),
//   tenantId: text('tenant_id').notNull(),   // Tenant Microsoft courant
//   role: roleEnum('role').notNull().default('collaborator'),
//   createdAt: timestamp('created_at').defaultNow().notNull(),
//   updatedAt: timestamp('updated_at').defaultNow().notNull(),
// })

// Placeholder — sera complété en Phase 2 avec Supabase + Drizzle
export const DB_SCHEMA_VERSION = '0.1.0'
