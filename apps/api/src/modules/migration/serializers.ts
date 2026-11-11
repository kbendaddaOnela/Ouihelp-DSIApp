// Sérialisation des lignes `migrations` vers le format d'API (dates ISO).
import type { migrations } from './schema'

export function serializeMigration(m: typeof migrations.$inferSelect) {
  return {
    ...m,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    tempPassword: m.tempPassword ?? null,
    mailStartedAt: m.mailStartedAt ? m.mailStartedAt.toISOString() : null,
    mailFinishedAt: m.mailFinishedAt ? m.mailFinishedAt.toISOString() : null,
    mailLastSyncAt: m.mailLastSyncAt ? m.mailLastSyncAt.toISOString() : null,
    calStartedAt: m.calStartedAt ? m.calStartedAt.toISOString() : null,
    calFinishedAt: m.calFinishedAt ? m.calFinishedAt.toISOString() : null,
    calLastSyncAt: m.calLastSyncAt ? m.calLastSyncAt.toISOString() : null,
    contactsStartedAt: m.contactsStartedAt ? m.contactsStartedAt.toISOString() : null,
    contactsFinishedAt: m.contactsFinishedAt ? m.contactsFinishedAt.toISOString() : null,
    contactsLastSyncAt: m.contactsLastSyncAt ? m.contactsLastSyncAt.toISOString() : null,
    archived: m.archived === 1,
    archivedAt: m.archivedAt ? m.archivedAt.toISOString() : null,
    credentialsSentAt: m.credentialsSentAt ? m.credentialsSentAt.toISOString() : null,
    signatureAppliedAt: m.signatureAppliedAt ? m.signatureAppliedAt.toISOString() : null,
  }
}

// Variante pour les listes : `exchangePsScript` est une colonne TEXT que le front
// ne lit jamais. La garder dans /history alourdissait chaque poll (toutes les 5 s
// pendant une migration) sans rien afficher. Elle reste servie par /migration/:id.
export function serializeMigrationLight(m: typeof migrations.$inferSelect) {
  // `undefined` est omis par JSON.stringify : la clé n'apparaît pas dans la réponse.
  return { ...serializeMigration(m), exchangePsScript: undefined }
}
