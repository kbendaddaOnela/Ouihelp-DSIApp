// Re-exports centralisés pour drizzle-kit et drizzle ORM
// Chaque module gère sa propre définition de table dans src/modules/<module>/schema.ts
export * from '../modules/auth/schema'
export * from '../modules/migration/schema'
