import { mysqlTable, varchar, timestamp, uniqueIndex } from 'drizzle-orm/mysql-core'

// Annuaire ONELA partagé : importé depuis un CSV, stocké côté app, puis poussé
// dans les contacts Google de chaque utilisateur (People API) pour qu'ils
// retrouvent leurs collègues pas encore migrés + les listes de diffusion.
export const onelaContacts = mysqlTable(
  'onela_contacts',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    givenName: varchar('given_name', { length: 255 }),
    familyName: varchar('family_name', { length: 255 }),
    organization: varchar('organization', { length: 255 }),
    title: varchar('title', { length: 255 }),
    email: varchar('email', { length: 255 }).notNull(),
    phone: varchar('phone', { length: 64 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex('onela_contacts_email_unique').on(t.email),
  })
)

export type OnelaContact = typeof onelaContacts.$inferSelect
export type NewOnelaContact = typeof onelaContacts.$inferInsert
