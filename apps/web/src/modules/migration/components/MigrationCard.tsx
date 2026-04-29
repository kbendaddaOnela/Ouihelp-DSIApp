import { useState } from 'react'
import { ChevronDown, ChevronUp, RefreshCw, Mail, Calendar, Users } from 'lucide-react'
import type { MigrationRecord } from '@dsi-app/shared'
import { cn } from '@/lib/utils'
import { StepBadge } from './StepBadge'
import { CopyButton } from './CopyButton'
import { DataMigrationSection } from './DataMigrationSection'
import {
  useAddGoogleAlias,
  useMigrateMail,
  useMigrateCalendar,
  useMigrateContacts,
} from '../hooks/useMigration'

export function MigrationCard({ m }: { m: MigrationRecord }) {
  const [expanded, setExpanded] = useState(false)
  const [aliasMessage, setAliasMessage] = useState<string | null>(null)
  const defaultAlias = m.onelaUpn.replace('@onela.com', '@test-mig.onela.com')
  const [aliasInput, setAliasInput] = useState(defaultAlias)

  const { mutate: addAlias, isPending: isAddingAlias } = useAddGoogleAlias()
  const { mutate: migrateMail, isPending: isStartingMail } = useMigrateMail()
  const { mutate: migrateCalendar, isPending: isStartingCalendar } = useMigrateCalendar()
  const { mutate: migrateContacts, isPending: isStartingContacts } = useMigrateContacts()

  const hasError = m.stepCreateAccount === 'error'
  const accountReady = m.stepCreateAccount === 'success'
  const canAddAlias = accountReady && m.stepGoogleAlias !== 'success'

  const handleAddAlias = () => {
    setAliasMessage(null)
    addAlias(
      { id: m.id, alias: aliasInput.trim() || undefined },
      {
        onSuccess: () => setAliasMessage(null),
        onError: (err: unknown) => {
          const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
            ?? (err instanceof Error ? err.message : 'Erreur inconnue')
          setAliasMessage(msg)
        },
      }
    )
  }

  return (
    <div className={cn('rounded-xl border bg-white p-4', hasError ? 'border-red-200' : 'border-gray-200')}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium text-gray-900">{m.onelaDisplayName}</p>
          <p className="text-xs text-gray-500">{m.onelaUpn}</p>
          {m.gohUpn && <p className="mt-0.5 text-xs text-blue-600">→ {m.gohUpn}</p>}
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          <StepBadge status={m.stepCreateAccount} label="Compte GOH" />
          <StepBadge status={m.stepSetAttributes} label="Attributs SCIM" />
          <StepBadge status={m.stepGroupMembership} label="Groupe dyn." />
          <StepBadge status={m.stepGoogleAlias} label="Alias Google" />
          <StepBadge status={m.stepMailMigration} label="Mail" />
          <StepBadge status={m.stepCalendarMigration} label="Calendrier" />
          <StepBadge status={m.stepContactsMigration} label="Contacts" />
        </div>
      </div>

      {hasError && m.errorDetails && (
        <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700">{m.errorDetails}</p>
      )}

      {m.tempPassword && (
        <div className="mt-3 flex items-center justify-between rounded bg-amber-50 px-3 py-2">
          <div>
            <p className="text-xs font-medium text-amber-800">Mot de passe temporaire</p>
            <code className="font-mono text-sm text-amber-900">{m.tempPassword}</code>
          </div>
          <CopyButton text={m.tempPassword} />
        </div>
      )}

      {canAddAlias && (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={aliasInput}
              onChange={(e) => setAliasInput(e.target.value)}
              placeholder="alias@domaine.com"
              className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              onClick={handleAddAlias}
              disabled={isAddingAlias || !aliasInput.trim()}
              className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-60"
            >
              <RefreshCw className={cn('h-3 w-3', isAddingAlias && 'animate-spin')} />
              {isAddingAlias ? 'Vérification…' : 'Ajouter alias Google'}
            </button>
          </div>
          {aliasMessage && (
            <p className={cn(
              'rounded px-2 py-1 text-xs',
              aliasMessage.includes('pas encore') ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'
            )}>
              {aliasMessage}
            </p>
          )}
        </div>
      )}

      {m.stepGoogleAlias === 'success' && (
        <p className="mt-2 text-xs text-green-600">✓ Alias <strong>{m.onelaUpn}</strong> ajouté sur {m.gohUpn}</p>
      )}

      {accountReady && (
        <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-3">
          <DataMigrationSection
            label="mail"
            icon={Mail}
            status={m.stepMailMigration}
            total={m.mailTotal}
            migrated={m.mailMigrated}
            failed={m.mailFailed}
            errorMessage={m.mailError}
            itemUnit="message"
            onStart={() => migrateMail(m.id)}
            isStarting={isStartingMail}
            startedAt={m.mailStartedAt}
            finishedAt={m.mailFinishedAt}
            lastSyncAt={m.mailLastSyncAt}
            color="purple"
          />
          <DataMigrationSection
            label="calendrier"
            icon={Calendar}
            status={m.stepCalendarMigration}
            total={m.calTotal}
            migrated={m.calMigrated}
            failed={m.calFailed}
            errorMessage={m.calError}
            itemUnit="événement"
            onStart={() => migrateCalendar(m.id)}
            isStarting={isStartingCalendar}
            startedAt={m.calStartedAt}
            finishedAt={m.calFinishedAt}
            lastSyncAt={m.calLastSyncAt}
            color="blue"
          />
          <DataMigrationSection
            label="contacts"
            icon={Users}
            status={m.stepContactsMigration}
            total={m.contactsTotal}
            migrated={m.contactsMigrated}
            failed={m.contactsFailed}
            errorMessage={m.contactsError}
            itemUnit="contact"
            onStart={() => migrateContacts(m.id)}
            isStarting={isStartingContacts}
            startedAt={m.contactsStartedAt}
            finishedAt={m.contactsFinishedAt}
            lastSyncAt={m.contactsLastSyncAt}
            color="emerald"
          />
        </div>
      )}

      {m.exchangePsScript && (
        <div className="mt-3">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900"
          >
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            Script PowerShell Exchange (ForwardingSMTPAddress)
          </button>
          {expanded && (
            <div className="mt-2 rounded border border-gray-200 bg-gray-50">
              <div className="flex justify-end border-b border-gray-200 px-3 py-1">
                <CopyButton text={m.exchangePsScript} />
              </div>
              <pre className="overflow-x-auto p-3 text-xs text-gray-700">{m.exchangePsScript}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
