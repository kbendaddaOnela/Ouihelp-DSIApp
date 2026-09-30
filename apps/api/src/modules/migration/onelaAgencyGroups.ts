// Groupes de sécurité ONELA pour les AGENCES et les RÉGIONS (Directions Régionales).
// Sert à la vue « Par agence / région » : on affiche les régions, puis leurs
// agences, puis les membres de chaque agence (sélectionnables pour lancer la
// migration).
//
// L'appartenance agence → région n'est PAS statique ici : on la calcule en direct
// (les membres d'une agence appartiennent tous à une seule Direction Régionale).
// Les deux listes viennent de l'export des groupes ONELA (SG-DYN-ONELA-*).
//
// Surchargeables via ONELA_REGION_GROUPS / ONELA_AGENCY_GROUPS (JSON).

export interface RegionGroup {
  label: string
  groupId: string
}

export interface AgencyGroup {
  code: string
  groupId: string
}

// 6 Directions Régionales (SG-DYN-ONELA-DR-*).
const DEFAULT_REGION_GROUPS: RegionGroup[] = [
  { label: 'IDF Est', groupId: 'cab9e1a3-d4b2-45c8-8904-641ea4db2c48' },
  { label: 'IDF Ouest', groupId: 'a409764e-aec6-4107-82b0-c92d14b6a5bf' },
  { label: 'Nord / Normandie / Est', groupId: 'ccdacbb6-ab26-4b89-b0de-cdb07683f52f' },
  { label: 'Ouest / Sud-Ouest', groupId: 'bc8b7ece-65c6-45e6-b8a6-b94ff25cf5dd' },
  { label: 'Rhône-Alpes', groupId: '849f85c7-d53f-4d1a-b12f-42ea8bc73129' },
  { label: 'Sud-Est', groupId: '74dcb413-9b27-4a76-9968-fed13d712f4c' },
]

// Agences (SG-DYN-ONELA-AG-*), code = suffixe du nom de groupe.
const DEFAULT_AGENCY_GROUPS: AgencyGroup[] = [
  { code: 'AIX', groupId: '87410147-2532-4b1e-b8d5-d0a20d798e69' },
  { code: 'AND', groupId: '59a2fca1-32b2-477a-b8c5-35957df4c462' },
  { code: 'ANT', groupId: '76822fb9-243b-41a2-b056-2590272ea772' },
  { code: 'ARG', groupId: '5682e1e1-3eb2-4886-9a44-cfb6b1b23a10' },
  { code: 'ARL', groupId: '4648d5eb-b299-4d80-8395-833b023c6ddf' },
  { code: 'ARM', groupId: '596b7c88-1dc7-4460-b36c-a06b489970e7' },
  { code: 'BEL', groupId: 'ef1ccf64-5100-4aaf-9d2f-faab2849a115' },
  { code: 'BIA', groupId: 'e1cb9ba2-587c-4f65-954a-ecbf46d65f57' },
  { code: 'BOU', groupId: '041ae76c-c10a-4646-8def-c7b88d7783b9' },
  { code: 'BRO', groupId: '16df1161-8e8c-401c-9490-a122ce37f624' },
  { code: 'BRU', groupId: '0c69b213-eb4a-4e28-b6fb-b136a6980cbe' },
  { code: 'BSC', groupId: '27ed2b0f-7387-4877-ba75-2021c10d2487' },
  { code: 'CAE', groupId: '74d6c338-1312-4b2f-849c-553d6e7eecfa' },
  { code: 'CAN', groupId: '7eb5741d-1624-4aa3-b87e-ddfc72d1fb6b' },
  { code: 'CHI', groupId: 'c90b118c-41f2-4e82-afd8-c14bb1ac7b87' },
  { code: 'CLI', groupId: '403b2139-8653-4432-9ba8-cd740613f828' },
  { code: 'COU', groupId: 'fcc7106e-c7e0-4eca-a8fb-da9b98c14ac7' },
  { code: 'CRX', groupId: '742f5912-bdfe-423a-957d-3b7b0fa338ce' },
  { code: 'CSM', groupId: '9f5f67a9-bb55-4a5f-ad4e-da97d8c2184b' },
  { code: 'DAM', groupId: 'a8dc41ba-0bd6-4703-8f45-96401b229a88' },
  { code: 'DIE', groupId: '2b0b5da0-1110-4890-b82d-10e162b6bafe' },
  { code: 'DIJ', groupId: '5f8146d4-e458-4da2-862d-4ee5b69b366c' },
  { code: 'ELB', groupId: 'c98139bb-2368-4850-a97f-7cf90f7f8f45' },
  { code: 'EVR', groupId: '46e019a0-d2d5-4537-8ac3-8ca49d67facb' },
  { code: 'FON', groupId: '15481c7c-d6e8-46cf-b146-35e9c33771c2' },
  { code: 'GAG', groupId: 'da3f92ad-2c9b-4d62-af40-a848deea5eb2' },
  { code: 'GIF', groupId: '5c9b3b50-be35-4ad9-993a-8da7143d6743' },
  { code: 'GRE', groupId: '552c1c63-a05f-4b9b-b883-17d8b99e3c31' },
  { code: 'HAZ', groupId: 'cbe08d32-f997-4772-a74e-9604e087f2cc' },
  { code: 'JOE', groupId: '49613f19-c3ea-4a16-bb05-5307c6a569ce' },
  { code: 'LAR', groupId: 'ae9aa502-f094-4f38-abb6-ce26c34b372e' },
  { code: 'LEM', groupId: '1e3c3e28-8385-48db-b494-7e0f5b0de84e' },
  { code: 'LIB', groupId: '6591ed7c-3268-4f9e-9ace-581e665859be' },
  { code: 'LIL', groupId: 'dae67c8f-18f0-4f59-99e5-d5d9e78f352a' },
  { code: 'LIM', groupId: '0c7af7c5-1b62-4138-8596-0b9cae0eb989' },
  { code: 'MAR', groupId: '1be0c27a-325b-4d04-a94d-460cc92865c4' },
  { code: 'MBR', groupId: 'b8b917e5-a22d-443f-b1c5-030a31484f78' },
  { code: 'MENT', groupId: 'a0544206-af0f-492f-bd27-b4e342cf1501' },
  { code: 'MET', groupId: 'a8214b1b-cf34-402c-a323-31e687feecbb' },
  { code: 'MON', groupId: '9cd1deeb-2ab2-4d74-a5ad-e139cc8b15cf' },
  { code: 'NAN', groupId: '134bb45a-ffd2-4254-9fc5-d74e7aca043f' },
  { code: 'NEU', groupId: '3bb22404-679b-44e6-b32a-245cd62cf408' },
  { code: 'NIC', groupId: '4df1706c-e463-41e3-add8-c4a02acca37f' },
  { code: 'NIM', groupId: '4af68c5f-9d5e-4a34-8963-00998f5d2f84' },
  { code: 'NOI', groupId: 'a403fd17-bf59-4871-bd89-ec13d6672753' },
  { code: 'ORL', groupId: '4185deb4-571e-4bc5-ba2d-f459b40ec6ce' },
  { code: 'PA13', groupId: '648ef7dc-40cc-4125-8c7b-f51e3d3ea575' },
  { code: 'PA16', groupId: '152207f1-6550-493e-a97a-2cf6fb2dd9ab' },
  { code: 'PAR', groupId: 'd6bdef76-0aba-44e4-a8a7-c0027bafba59' },
  { code: 'REI', groupId: 'e0406aaf-53f9-4e75-b8b4-aee2b1fb8b39' },
  { code: 'REN', groupId: '14fe3315-13a7-40ac-83df-969c79ec01eb' },
  { code: 'ROU', groupId: '81edcba2-f791-4a2c-bae2-80d97f28ddb4' },
  { code: 'SAI', groupId: '1d03f33c-6075-42f9-a1b4-0452ca8d1b14' },
  { code: 'SAN', groupId: '1ce5e381-016e-4e08-9da2-9f7a8dec3540' },
  { code: 'SCH', groupId: '215a1294-0bbd-49ed-b2ff-334fde837637' },
  { code: 'STM', groupId: 'c9bd0aca-ad29-481f-a4b8-9eaccc6d7e01' },
  { code: 'STR', groupId: '85f57518-8c42-419a-8a53-b69def42b60e' },
  { code: 'STS', groupId: '95f2a75f-78b4-4224-bf7c-c5128438b0b2' },
  { code: 'THI', groupId: '139c726d-e5e2-4ed0-85dc-7c14e4b33e15' },
  { code: 'TOU', groupId: '5b3468a3-aa5e-4bad-989f-2978859cbab2' },
  { code: 'VAL', groupId: '473fcd65-c993-46d8-93cf-fc57200e5d37' },
  { code: 'VER', groupId: '9c8f9934-fa77-4858-90fa-3d8adc6424a2' },
  { code: 'VIB', groupId: '8e7727c2-d042-4f87-9e4b-f465865d599d' },
  { code: 'VIE', groupId: 'b941ad4b-d28a-4ca9-9716-100df1cb19a0' },
  { code: 'VIF', groupId: '27d34502-9616-41eb-aa69-e39d05cf12d3' },
  { code: 'VIN', groupId: '082ebcef-e22c-483d-ab3b-17024d246e3f' },
  { code: 'YVE', groupId: '7b2cdaca-5255-48b4-800c-80a23a2e429d' },
]

export function getRegionGroups(): RegionGroup[] {
  const raw = process.env['ONELA_REGION_GROUPS']
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as RegionGroup[]
      if (Array.isArray(parsed) && parsed.every((g) => g.label && g.groupId)) return parsed
    } catch { /* JSON invalide → défaut */ }
  }
  return DEFAULT_REGION_GROUPS
}

export function getAgencyGroups(): AgencyGroup[] {
  const raw = process.env['ONELA_AGENCY_GROUPS']
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as AgencyGroup[]
      if (Array.isArray(parsed) && parsed.every((g) => g.code && g.groupId)) return parsed
    } catch { /* JSON invalide → défaut */ }
  }
  return DEFAULT_AGENCY_GROUPS
}
