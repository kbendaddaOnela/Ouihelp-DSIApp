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
import { parseProfileMap } from './profileMapping'

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
const GRAPH_BETA = 'https://graph.microsoft.com/beta'
const MAX_STEPS = 200
/** Inscription Intune après la jonction : on la cherche pendant ~5 min (30 s entre deux essais). */
const PRIMARY_USER_TRIES = 10

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
/** Statuts depuis lesquels la DSI peut encore annuler sans risque (rien n'a été touché sur le poste). */
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
    mode: r.migrationMode === 'inplace' ? 'inplace' : 'reset',
    requestedBy: r.migrationRequestedBy,
    requestedAt: r.migrationRequestedAt?.toISOString() ?? null,
    updatedAt: r.migrationUpdatedAt?.toISOString() ?? null,
    error: r.migrationError,
    steps: parseSteps(r.migrationSteps),
    hasBreakglass: !!r.breakglassPassword,
    promptUser: r.migrationPromptUser === 1,
    snoozeCount: r.migrationSnoozes,
    snoozeExhausted: r.migrationSnoozes >= MIGRATION_MAX_SNOOZES,
    profiles: parseProfileMap(r.migrationProfileMap),
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
    // Bascule en place : le poste ne réinstalle pas Windows, il ne peut donc pas être rattrapé
    // par le profil Autopilot ONELA. L'étape reste utile (ménage) mais ne doit pas bloquer.
    if (d.migrationMode === 'inplace') {
      await recordStep(
        id,
        {
          step: 'autopilot-onela',
          status: 'error',
          source: 'serveur',
          message: `${msg} - sans effet sur une bascule en place (pas de réinstallation) : on continue, entrée Autopilot ONELA à retirer à la main`,
        },
        { status: 'ready' }
      )
      return
    }
    await recordStep(
      id,
      { step: 'autopilot-onela', status: 'error', source: 'serveur', message: msg },
      { status: 'failed', error: msg }
    )
  }
}

/**
 * Appareil dans Intune Ouihelp, cherché par n° de série. Juste après la jonction, l'inscription
 * Intune n'est pas encore faite : on réessaie pendant quelques minutes. Le filtre sur
 * serialNumber n'est pas accepté partout, d'où le repli sur la liste des postes Windows.
 */
async function findOuihelpIntuneDevice(token: string, serial: string): Promise<string | null> {
  const filtered = await graph(
    token,
    'GET',
    `${GRAPH_BETA}/deviceManagement/managedDevices?$filter=serialNumber eq '${encodeURIComponent(serial)}'&$select=id,serialNumber,enrolledDateTime`
  )
  if (filtered.status === 200) {
    // Plusieurs inscriptions pour le même n° de série (tests, réinscription) : la plus récente
    const hits =
      (filtered.json as { value?: Array<{ id: string; enrolledDateTime?: string }> })?.value ?? []
    hits.sort((a, b) => (b.enrolledDateTime ?? '').localeCompare(a.enrolledDateTime ?? ''))
    return hits[0]?.id ?? null
  }
  const all = await graph(
    token,
    'GET',
    `/deviceManagement/managedDevices?$filter=operatingSystem eq 'Windows'&$select=id,serialNumber&$top=999`
  )
  if (all.status !== 200) throw new Error(graphError('Lecture des appareils Intune Ouihelp', all))
  const devices =
    (all.json as { value?: Array<{ id: string; serialNumber?: string }> })?.value ?? []
  return devices.find((x) => x.serialNumber?.trim().toUpperCase() === serial)?.id ?? null
}

/**
 * Bascule en place : utilisateur principal de l'appareil dans Intune Ouihelp = le compte qui a
 * hérité du profil Windows. Sans ça l'appareil reste sans utilisateur principal (il a été
 * inscrit par un jeton en bloc, pas par une personne) et sort des groupes et rapports par
 * utilisateur. Best-effort : la prochaine synchro d'inventaire montrera le résultat.
 */
async function setOuihelpPrimaryUser(
  d: DeviceMigrationRow,
  step: (status: 'ok' | 'error' | 'info', message: string) => Promise<void>
): Promise<void> {
  const main = parseProfileMap(d.migrationProfileMap).find((m) => m.newUpn)
  if (!main?.newUpn) {
    await step('info', 'Aucun profil transféré : utilisateur principal Intune non renseigné')
    return
  }
  if (!d.serialNumber) {
    await step('info', 'N° de série inconnu : utilisateur principal Intune non renseigné')
    return
  }
  const token = await ouihelpToken()
  // Toujours relu : l'identifiant de l'inventaire peut dater d'une inscription précédente
  let intuneId: string | null = null
  for (let i = 0; !intuneId && i < PRIMARY_USER_TRIES; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 30_000))
    intuneId = await findOuihelpIntuneDevice(token, d.serialNumber)
  }
  if (!intuneId) {
    await step(
      'info',
      `Appareil pas encore inscrit dans Intune Ouihelp : définir ${main.newUpn} comme utilisateur principal après la prochaine synchro`
    )
    return
  }
  const user = await graph(token, 'GET', `/users/${encodeURIComponent(main.newUpn)}?$select=id`)
  const userId = (user.json as { id?: string })?.id
  if (user.status !== 200 || !userId) {
    await step('error', graphError(`Lecture du compte Ouihelp ${main.newUpn}`, user))
    return
  }
  // L'utilisateur principal ne s'écrit qu'en beta (la v1.0 répond 404 ResourceNotFound)
  const r = await graph(
    token,
    'POST',
    `${GRAPH_BETA}/deviceManagement/managedDevices/${intuneId}/users/$ref`,
    { '@odata.id': `${GRAPH_BETA}/users/${userId}` }
  )
  await step(
    r.status < 300 ? 'ok' : 'error',
    r.status < 300
      ? `Utilisateur principal Intune Ouihelp : ${main.newUpn}`
      : graphError('Utilisateur principal Intune Ouihelp', r)
  )
}

/**
 * Objets Entra ONELA du poste. Les identifiants de l'inventaire peuvent être périmés (PC
 * rejoint ONELA entre-temps → nouvel objet) : on recherche par deviceId, en partant de tous
 * ceux connus (inventaire + agent au moment de la programmation), et on supprime ce qui existe.
 */
async function deleteOnelaEntraDevices(
  token: string,
  d: DeviceMigrationRow,
  step: (status: 'ok' | 'error' | 'info', message: string) => Promise<void>
): Promise<void> {
  let objects: DeviceEntraObject[] = []
  try {
    objects = JSON.parse(d.onelaEntraObjects ?? '[]') as DeviceEntraObject[]
  } catch {
    objects = []
  }
  let captured: string[] = []
  try {
    captured = JSON.parse(d.migrationOnelaDeviceIds ?? '[]') as string[]
  } catch {
    captured = []
  }
  const deviceIds = new Set(
    [d.onelaEntraDeviceId, ...objects.map((o) => o.deviceId), ...captured]
      .filter((x): x is string => !!x)
      .map((x) => x.toLowerCase())
  )
  const found = new Map<string, string | null>() // objectId → trustType
  for (const id of deviceIds) {
    const r = await graph(token, 'GET', `/devices?$filter=deviceId eq '${id}'&$select=id,trustType`)
    if (r.status !== 200) {
      await step('error', graphError('Recherche Entra ONELA', r))
      continue
    }
    for (const o of (r.json as { value?: Array<{ id: string; trustType?: string }> })?.value ?? [])
      found.set(o.id, o.trustType ?? null)
  }
  if (found.size === 0) {
    await step('ok', 'Aucun objet Entra ONELA restant pour ce poste')
    return
  }
  for (const [objectId, trustType] of found) {
    const r = await graph(token, 'DELETE', `/devices/${objectId}`)
    await step(
      r.status < 400 || r.status === 404 ? 'ok' : 'error',
      r.status < 400 || r.status === 404
        ? `Objet Entra ONELA ${trustType ?? ''} supprimé`
        : graphError('Suppression Entra ONELA', r)
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
    await deleteOnelaEntraDevices(ol, d, step)
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

  if (d.migrationMode === 'inplace') {
    try {
      await setOuihelpPrimaryUser(d, step)
    } catch (err) {
      await step(
        'error',
        `Utilisateur principal Intune Ouihelp : ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}
