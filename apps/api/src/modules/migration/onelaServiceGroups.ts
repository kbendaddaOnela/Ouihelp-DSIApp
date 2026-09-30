// Correspondance « service » → groupe de sécurité dynamique ONELA (SG-DYN-ONELA-*).
// Sert à recompter en direct l'effectif de chaque service depuis l'appartenance
// aux groupes (l'attribut `department` des comptes n'étant pas fiable).
//
// Liste curée : on ne garde que les groupes FONCTIONNELS (services), pas les 65
// groupes agence `AG-*` ni les découpages régionaux (DR/RA/RG/RS-*), qui ne sont
// pas des services au sens du suivi de migration.
//
// Surchargeable sans redéploiement via la variable d'env ONELA_SERVICE_GROUPS
// (JSON : [{ "label": "...", "groupId": "..." }, ...]).

export interface ServiceGroup {
  label: string
  groupId: string
}

const DEFAULT_SERVICE_GROUPS: ServiceGroup[] = [
  { label: 'DSI', groupId: 'd9521685-605f-418e-8aed-51ef3af648a6' },
  { label: 'Marketing', groupId: '84649921-1cc4-4f25-af88-ca5fc532ae3d' },
  { label: 'Finance', groupId: '9ecf7bcb-10a8-4441-b33b-459a61118a2f' },
  { label: 'Finance - ADV', groupId: '7672cbb0-7ed3-4a7f-9183-00466e971746' },
  { label: 'Finance - CDG', groupId: 'ad1b56f8-a08e-4965-ad97-ab3af0a6cb4f' },
  { label: 'Finance - Compta', groupId: '04cc89f0-505d-42cf-9351-281b90f005c5' },
  { label: 'RH', groupId: '486a3b53-8042-4147-a9e6-21d9f67edd99' },
  { label: 'RH - Formation', groupId: '50e89cce-8dd9-4908-8760-2a3204d1fd69' },
  { label: 'RH - Paie', groupId: '22f79ef7-bc61-4efb-a352-23835222b9b9' },
  { label: 'RH - Recrutement', groupId: 'cb04e9bc-8160-4feb-9034-9ae5c881ed60' },
  { label: 'RH - SRH', groupId: 'f7dd27b7-15f8-4211-b2cf-951e7c2131b8' },
  { label: 'Réseau', groupId: '4ecd0da8-33ad-41b3-8196-422afef37540' },
  { label: 'Cadres', groupId: '74c9e9c7-8a4d-429c-a9ad-29c7636d9c70' },
  { label: 'Siège', groupId: '86fd8a52-bab7-431f-b87c-702dfb1c132a' },
  { label: 'Agences', groupId: '0f4fac9d-0ae8-419d-8795-90d442ca1415' },
]

export function getServiceGroups(): ServiceGroup[] {
  const raw = process.env['ONELA_SERVICE_GROUPS']
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as ServiceGroup[]
      if (Array.isArray(parsed) && parsed.every((g) => g.label && g.groupId)) return parsed
    } catch {
      // JSON invalide → on retombe sur la liste par défaut
    }
  }
  return DEFAULT_SERVICE_GROUPS
}
