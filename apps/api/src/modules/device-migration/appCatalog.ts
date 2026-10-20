import type { DeviceAgentApp, DeviceAgentReport, DeviceAppCatalogEntry } from '@dsi-app/shared'
import { db } from '../../db/index'
import { deviceAgents, deviceAppRules } from './schema'

/**
 * Catalogue des applications du parc, construit à partir du dernier rapport de chaque agent.
 * La DSI décide une fois par application (pour tout le parc) : conservée ou désinstallée à la
 * bascule en place. Une application jamais revue est conservée.
 */

/**
 * Nom normalisé : minuscules, sans numéro de version ni architecture, pour qu'une mise à jour
 * (« Zoom 6.1.2 » → « Zoom 6.2.0 ») garde la même règle.
 */
export function appKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\((x64|x86|64[- ]bits?|32[- ]bits?)\)/g, ' ')
    .replace(/\bv?\d+(\.\d+)+\b/g, ' ')
    .replace(/\s+[-–]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s\-–:,(]+$/g, '')
    .trim()
    .slice(0, 255)
}

function reportApps(raw: string | null): DeviceAgentApp[] {
  if (!raw) return []
  try {
    return (JSON.parse(raw) as DeviceAgentReport).apps ?? []
  } catch {
    return []
  }
}

export async function loadAppRules(): Promise<Map<string, boolean>> {
  const rows = await db.select().from(deviceAppRules)
  return new Map(rows.map((r) => [r.appKey, r.keep === 1]))
}

export async function buildAppCatalog(): Promise<DeviceAppCatalogEntry[]> {
  const [agents, rules] = await Promise.all([
    db
      .select({ report: deviceAgents.report, deviceId: deviceAgents.deviceMigrationId })
      .from(deviceAgents),
    db.select().from(deviceAppRules),
  ])
  const ruleByKey = new Map(rules.map((r) => [r.appKey, r]))
  const byKey = new Map<string, DeviceAppCatalogEntry & { devices: Set<string> }>()
  for (const a of agents) {
    const device = a.deviceId ?? ''
    for (const app of reportApps(a.report)) {
      const key = appKey(app.name)
      if (!key) continue
      let e = byKey.get(key)
      if (!e) {
        const rule = ruleByKey.get(key)
        e = {
          key,
          name: app.name,
          publisher: app.publisher,
          deviceCount: 0,
          uninstallableCount: 0,
          keep: rule ? rule.keep === 1 : null,
          updatedBy: rule?.updatedBy ?? null,
          updatedAt: rule?.updatedAt.toISOString() ?? null,
          devices: new Set(),
        }
        byKey.set(key, e)
      }
      if (e.devices.has(device)) continue
      e.devices.add(device)
      e.deviceCount++
      if (app.uninstallable) e.uninstallableCount++
    }
  }
  return [...byKey.values()]
    .map(({ devices: _devices, ...e }) => e)
    .sort((a, b) => b.deviceCount - a.deviceCount || a.name.localeCompare(b.name))
}

/** Applications de CE poste à désinstaller (noms exacts remontés par son agent). */
export function appsToRemove(
  report: DeviceAgentReport | null,
  rules: Map<string, boolean>
): string[] {
  return (report?.apps ?? []).filter((a) => rules.get(appKey(a.name)) === false).map((a) => a.name)
}
