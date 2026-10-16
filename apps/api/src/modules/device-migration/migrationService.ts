import { createHash, randomBytes, randomInt } from 'crypto'
import { eq } from 'drizzle-orm'
import {
  MIGRATION_MAX_SNOOZES,
  type DeviceEntraObject,
  type DeviceMigrationRun,
  type MigrationStatus,
  type MigrationStep,
} from '@dsi-app/shared'
import { db } from '../../db/index'
import { getMsToken, onelaCreds, ouihelpCreds } from '../inventory/syncService'
import { deviceMigrations, type DeviceMigrationRow } from './schema'

/**
 * Bascule d'un poste vers Ouihelp par réinstallation propre (lot 3).
 *
 * Le PC fait l'essentiel (agent puis nouveau Windows) ; le serveur tient l'état, le journal
 * des étapes, et les opérations Graph :
 *  - AVANT la réinitialisation : retirer le PC d'Autopilot ONELA. Sinon, s'il est en
 *    Ethernet, l'installation de Windows récupère le profil Autopilot ONELA et le PC se
 *    réinscrit chez ONELA. Étape bloquante.
 *  - APRÈS la jonction Ouihelp : supprimer les objets Intune et Entra ONELA (best-effort) et
 *    importer l'empreinte matérielle dans Autopilot Ouihelp.
 */

export const BREAKGLASS_USER = 'dsi-secours'
/** Étiquette Autopilot Ouihelp, la même que le script de migration Intune existant (groupes dynamiques) */
export const GROUP_TAG = process.env['DEVICE_MIGRATION_GROUP_TAG'] ?? 'OUIHELP'
const GRAPH = 'https://graph.microsoft.com/v1.0'
const MAX_STEPS = 200

/** Statuts pendant lesquels une bascule est en cours (une seule à la fois par poste). */
export const ACTIVE_STATUSES: MigrationStatus[] = [
  'scheduled',
  'staging',
  'staged',
  'cleanup',
  'ready',
  'resetting',
  'joining',
]
/** Statuts depuis lesquels la DSI peut encore annuler sans risque (rien n'a été touché côté ONELA). */
export const CANCELLABLE_STATUSES: MigrationStatus[] = ['scheduled', 'staging', 'staged']

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/** Mot de passe sans caractères spéciaux XML ni guillemets : il est écrit dans unattend.xml. */
export function generateBreakglassPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const symbols = '-_.!%+='
  let p = ''
  for (let i = 0; i < 18; i++) p += alphabet[randomInt(alphabet.length)]
  // Complexité Windows : au moins un chiffre, une majuscule, une minuscule, un symbole
  return `${p}${symbols[randomInt(symbols.length)]}${randomInt(10)}Aa`
}

export function generateReportToken(): string {
  return randomBytes(32).toString('base64url')
}

export function parseSteps(raw: string | null): MigrationStep[] {
  if (!raw) return []
  try {
    return JSON.parse(raw) as MigrationStep[]
  } catch {
    return []
  }
}

export function toMigrationRun(r: DeviceMigrationRow): DeviceMigrationRun | null {
  if (!r.migrationStatus) return null
  return {
    status: r.migrationStatus as MigrationStatus,
    mode: 'reset',
    requestedBy: r.migrationRequestedBy,
    requestedAt: r.migrationRequestedAt?.toISOString() ?? null,
    updatedAt: r.migrationUpdatedAt?.toISOString() ?? null,
    error: r.migrationError,
    steps: parseSteps(r.migrationSteps),
    hasBreakglass: !!r.breakglassPassword,
    promptUser: r.migrationPromptUser === 1,
    snoozeCount: r.migrationSnoozes,
    snoozeExhausted: r.migrationSnoozes >= MIGRATION_MAX_SNOOZES,
  }
}

/**
 * Ajoute une étape au journal et, si demandé, change le statut. Relit la ligne pour ne pas
 * écraser une étape écrite en parallèle (agent et serveur écrivent tous deux).
 */
export async function recordStep(
  id: string,
  step: Omit<MigrationStep, 'at'>,
  patch: { status?: MigrationStatus; error?: string | null } = {}
): Promise<void> {
  const [row] = await db
    .select({ steps: deviceMigrations.migrationSteps })
    .from(deviceMigrations)
    .where(eq(deviceMigrations.id, id))
  if (!row) return
  const steps = parseSteps(row.steps)
  steps.push({ ...step, message: step.message.slice(0, 1000), at: new Date().toISOString() })
  await db
    .update(deviceMigrations)
    .set({
      migrationSteps: JSON.stringify(steps.slice(-MAX_STEPS)),
      migrationUpdatedAt: new Date(),
      ...(patch.status ? { migrationStatus: patch.status } : {}),
      ...(patch.error !== undefined ? { migrationError: patch.error } : {}),
    })
    .where(eq(deviceMigrations.id, id))
}

// ── Graph ────────────────────────────────────────────────────────────────────

async function graph(
  token: string,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body?: unknown
): Promise<{ status: number; json: unknown; text: string }> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url.startsWith('http') ? url : `${GRAPH}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = Number(res.headers.get('Retry-After') ?? 0) * 1000 || 2000 * attempt
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, json, text }
  }
}

function graphError(label: string, r: { status: number; text: string }): string {
  const hint = r.status === 403 ? ' — permission applicative manquante ?' : ''
  return `${label} : HTTP ${r.status}${hint} ${r.text.slice(0, 200)}`
}

async function onelaToken(): Promise<string> {
  const c = onelaCreds()
  return getMsToken(c.tid, c.cid, c.sec)
}

async function ouihelpToken(): Promise<string> {
  const c = ouihelpCreds()
  return getMsToken(c.tid, c.cid, c.sec)
}

interface AutopilotIdentity {
  id: string
  serialNumber: string
}

async function findOnelaAutopilot(token: string, serial: string): Promise<AutopilotIdentity[]> {
  const r = await graph(
    token,
    'GET',
    `/deviceManagement/windowsAutopilotDeviceIdentities?$filter=contains(serialNumber,'${encodeURIComponent(serial)}')`
  )
  if (r.status !== 200) throw new Error(graphError('Lecture Autopilot ONELA', r))
  const all = (r.json as { value?: AutopilotIdentity[] })?.value ?? []
  // contains() est large : on ne garde que le n° de série exact
  return all.filter((a) => a.serialNumber?.trim().toUpperCase() === serial)
}

/**
 * Étape bloquante avant réinitialisation : le PC ne doit plus figurer dans Autopilot ONELA.
 * Intune peut refuser la suppression tant que le PC y est inscrit : on supprime alors
 * l'appareil Intune ONELA puis on réessaie.
 */
export async function cleanupOnelaBeforeReset(id: string): Promise<void> {
  const [d] = await db.select().from(deviceMigrations).where(eq(deviceMigrations.id, id))
  if (!d) return
  try {
    if (!d.serialNumber) {
      // Sans n° de série fiable on ne peut pas vérifier Autopilot : on bloque plutôt que risquer
      throw new Error('N° de série inconnu : impossible de vérifier Autopilot ONELA')
    }
    const token = await onelaToken()
    let entries = await findOnelaAutopilot(token, d.serialNumber)
    if (entries.length === 0) {
      await recordStep(
        id,
        {
          step: 'autopilot-onela',
          status: 'ok',
          source: 'serveur',
          message: 'Absent d’Autopilot ONELA',
        },
        { status: 'ready' }
      )
      return
    }
    for (const e of entries) {
      let del = await graph(
        token,
        'DELETE',
        `/deviceManagement/windowsAutopilotDeviceIdentities/${e.id}`
      )
      if (del.status >= 400 && d.onelaIntuneId) {
        await recordStep(id, {
          step: 'autopilot-onela',
          status: 'info',
          source: 'serveur',
          message: `Suppression Autopilot refusée (HTTP ${del.status}) : suppression préalable de l’appareil Intune ONELA`,
        })
        const intune = await graph(
          token,
          'DELETE',
          `/deviceManagement/managedDevices/${d.onelaIntuneId}`
        )
        if (intune.status >= 400 && intune.status !== 404)
          throw new Error(graphError('Suppression Intune ONELA', intune))
        await new Promise((r) => setTimeout(r, 15_000))
        del = await graph(
          token,
          'DELETE',
          `/deviceManagement/windowsAutopilotDeviceIdentities/${e.id}`
        )
      }
      if (del.status >= 400 && del.status !== 404)
        throw new Error(graphError('Suppression Autopilot ONELA', del))
    }
    // La suppression est asynchrone côté Autopilot : on attend qu'elle soit visible (5 min max)
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 15_000))
      entries = await findOnelaAutopilot(token, d.serialNumber)
      if (entries.length === 0) break
    }
    if (entries.length > 0)
      throw new Error('Toujours présent dans Autopilot ONELA après 5 min : réessayer plus tard')
    await recordStep(
      id,
      {
        step: 'autopilot-onela',
        status: 'ok',
        source: 'serveur',
        message: 'Retiré d’Autopilot ONELA',
      },
      { status: 'ready' }
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await recordStep(
      id,
      { step: 'autopilot-onela', status: 'error', source: 'serveur', message: msg },
      { status: 'failed', error: msg }
    )
  }
}

/**
 * Après jonction Ouihelp : nettoyage ONELA et enregistrement Autopilot Ouihelp. Chaque
 * opération est indépendante et best-effort (le tenant ONELA disparaît de toute façon).
 */
export async function finalizeAfterJoin(id: string): Promise<void> {
  const [d] = await db.select().from(deviceMigrations).where(eq(deviceMigrations.id, id))
  if (!d) return
  const step = (status: 'ok' | 'error' | 'info', message: string) =>
    recordStep(id, { step: 'finalisation', status, source: 'serveur', message })

  try {
    const ol = await onelaToken()
    if (d.onelaIntuneId) {
      const r = await graph(ol, 'DELETE', `/deviceManagement/managedDevices/${d.onelaIntuneId}`)
      await step(
        r.status < 400 || r.status === 404 ? 'ok' : 'error',
        r.status < 400 || r.status === 404
          ? 'Appareil Intune ONELA supprimé'
          : graphError('Suppression Intune ONELA', r)
      )
    }
    let objects: DeviceEntraObject[] = []
    try {
      objects = JSON.parse(d.onelaEntraObjects ?? '[]') as DeviceEntraObject[]
    } catch {
      objects = []
    }
    for (const o of objects) {
      const r = await graph(ol, 'DELETE', `/devices/${o.objectId}`)
      await step(
        r.status < 400 || r.status === 404 ? 'ok' : 'error',
        r.status < 400 || r.status === 404
          ? `Objet Entra ONELA ${o.trustType ?? ''} supprimé`
          : graphError('Suppression Entra ONELA', r)
      )
    }
  } catch (err) {
    await step('error', `Nettoyage ONELA : ${err instanceof Error ? err.message : String(err)}`)
  }

  if (d.hardwareHash && d.serialNumber) {
    try {
      const oh = await ouihelpToken()
      const r = await graph(
        oh,
        'POST',
        '/deviceManagement/importedWindowsAutopilotDeviceIdentities',
        {
          '@odata.type': '#microsoft.graph.importedWindowsAutopilotDeviceIdentity',
          serialNumber: d.serialNumber,
          hardwareIdentifier: d.hardwareHash,
          groupTag: GROUP_TAG,
        }
      )
      await step(
        r.status < 300 ? 'ok' : 'error',
        r.status < 300
          ? 'Empreinte importée dans Autopilot Ouihelp (traitement asynchrone)'
          : graphError('Import Autopilot Ouihelp', r)
      )
    } catch (err) {
      await step(
        'error',
        `Import Autopilot Ouihelp : ${err instanceof Error ? err.message : String(err)}`
      )
    }
  } else {
    await step('info', 'Pas d’empreinte matérielle : import Autopilot Ouihelp ignoré')
  }
}
