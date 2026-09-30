// Groupes de sécurité ONELA pour les AGENCES, avec leur RÉGION et leur nom complet.
// Sert à la vue « Par agence / région » : régions → agences → membres
// (sélectionnables pour lancer la migration).
//
// La région vient d'un mapping STATIQUE (fourni par la DSI ONELA), car l'attribut
// région n'est pas renseigné dans Entra et les groupes Direction Régionale
// dynamiques sont vides — le calcul « en direct » renvoyait tout en « Sans région ».
//
// Surchargeable via ONELA_AGENCY_GROUPS (JSON : [{code,name,region,groupId}, ...]).

export interface AgencyGroup {
  code: string
  name: string
  region: string
  groupId: string
}

const DEFAULT_AGENCY_GROUPS: AgencyGroup[] = [
  { code: 'CSM', name: 'Champs-sur-Marne', region: 'IDF Est', groupId: '9f5f67a9-bb55-4a5f-ad4e-da97d8c2184b' },
  { code: 'CHI', name: 'Chilly-Mazarin', region: 'IDF Est', groupId: 'c90b118c-41f2-4e82-afd8-c14bb1ac7b87' },
  { code: 'CLI', name: 'Clichy-sous-Bois', region: 'IDF Est', groupId: '403b2139-8653-4432-9ba8-cd740613f828' },
  { code: 'FON', name: 'Fontainebleau', region: 'IDF Est', groupId: '15481c7c-d6e8-46cf-b146-35e9c33771c2' },
  { code: 'GAG', name: 'Gagny', region: 'IDF Est', groupId: 'da3f92ad-2c9b-4d62-af40-a848deea5eb2' },
  { code: 'DAM', name: 'Melun', region: 'IDF Est', groupId: 'a8dc41ba-0bd6-4703-8f45-96401b229a88' },
  { code: 'NOI', name: 'Noisy-le-sec', region: 'IDF Est', groupId: 'a403fd17-bf59-4871-bd89-ec13d6672753' },
  { code: 'STM', name: 'Saint-Maur-des-Fossés', region: 'IDF Est', groupId: 'c9bd0aca-ad29-481f-a4b8-9eaccc6d7e01' },
  { code: 'GIF', name: 'Savigny-sur-Orge', region: 'IDF Est', groupId: '5c9b3b50-be35-4ad9-993a-8da7143d6743' },
  { code: 'THI', name: 'Thiais', region: 'IDF Est', groupId: '139c726d-e5e2-4ed0-85dc-7c14e4b33e15' },
  { code: 'VIN', name: 'Vincennes', region: 'IDF Est', groupId: '082ebcef-e22c-483d-ab3b-17024d246e3f' },
  { code: 'ANT', name: 'Antony', region: 'IDF Ouest', groupId: '76822fb9-243b-41a2-b056-2590272ea772' },
  { code: 'ARG', name: 'Argenteuil', region: 'IDF Ouest', groupId: '5682e1e1-3eb2-4886-9a44-cfb6b1b23a10' },
  { code: 'BOU', name: 'Boulogne-Billancourt', region: 'IDF Ouest', groupId: '041ae76c-c10a-4646-8def-c7b88d7783b9' },
  { code: 'COU', name: 'La Garenne-Colombes', region: 'IDF Ouest', groupId: 'fcc7106e-c7e0-4eca-a8fb-da9b98c14ac7' },
  { code: 'NEU', name: 'Neuilly-sur-Seine', region: 'IDF Ouest', groupId: '3bb22404-679b-44e6-b32a-245cd62cf408' },
  { code: 'ORL', name: 'Orléans', region: 'IDF Ouest', groupId: '4185deb4-571e-4bc5-ba2d-f459b40ec6ce' },
  { code: 'PAR', name: 'Paris 11', region: 'IDF Ouest', groupId: 'd6bdef76-0aba-44e4-a8a7-c0027bafba59' },
  { code: 'PA13', name: 'Paris 13', region: 'IDF Ouest', groupId: '648ef7dc-40cc-4125-8c7b-f51e3d3ea575' },
  { code: 'PA16', name: 'Paris 16', region: 'IDF Ouest', groupId: '152207f1-6550-493e-a97a-2cf6fb2dd9ab' },
  { code: 'SAI', name: 'Saint-Germain-en-Laye', region: 'IDF Ouest', groupId: '1d03f33c-6075-42f9-a1b4-0452ca8d1b14' },
  { code: 'VER', name: 'Versailles', region: 'IDF Ouest', groupId: '9c8f9934-fa77-4858-90fa-3d8adc6424a2' },
  { code: 'ARM', name: 'Armentières', region: 'Nord Normandie EST', groupId: '596b7c88-1dc7-4460-b36c-a06b489970e7' },
  { code: 'CAE', name: 'Caen', region: 'Nord Normandie EST', groupId: '74d6c338-1312-4b2f-849c-553d6e7eecfa' },
  { code: 'CRX', name: 'Croix', region: 'Nord Normandie EST', groupId: '742f5912-bdfe-423a-957d-3b7b0fa338ce' },
  { code: 'DIE', name: 'Dieppe', region: 'Nord Normandie EST', groupId: '2b0b5da0-1110-4890-b82d-10e162b6bafe' },
  { code: 'ELB', name: 'Elbeuf', region: 'Nord Normandie EST', groupId: 'c98139bb-2368-4850-a97f-7cf90f7f8f45' },
  { code: 'EVR', name: 'Evreux', region: 'Nord Normandie EST', groupId: '46e019a0-d2d5-4537-8ac3-8ca49d67facb' },
  { code: 'HAZ', name: 'Hazebrouck', region: 'Nord Normandie EST', groupId: 'cbe08d32-f997-4772-a74e-9604e087f2cc' },
  { code: 'JOE', name: 'Joeuf', region: 'Nord Normandie EST', groupId: '49613f19-c3ea-4a16-bb05-5307c6a569ce' },
  { code: 'LIL', name: 'Lille', region: 'Nord Normandie EST', groupId: 'dae67c8f-18f0-4f59-99e5-d5d9e78f352a' },
  { code: 'MET', name: 'Metz', region: 'Nord Normandie EST', groupId: 'a8214b1b-cf34-402c-a323-31e687feecbb' },
  { code: 'REI', name: 'Reims', region: 'Nord Normandie EST', groupId: 'e0406aaf-53f9-4e75-b8b4-aee2b1fb8b39' },
  { code: 'ROU', name: 'Rouen', region: 'Nord Normandie EST', groupId: '81edcba2-f791-4a2c-bae2-80d97f28ddb4' },
  { code: 'STR', name: 'Strasbourg', region: 'Nord Normandie EST', groupId: '85f57518-8c42-419a-8a53-b69def42b60e' },
  { code: 'VAL', name: 'Valenciennes', region: 'Nord Normandie EST', groupId: '473fcd65-c993-46d8-93cf-fc57200e5d37' },
  { code: 'YVE', name: 'Yvetot', region: 'Nord Normandie EST', groupId: '7b2cdaca-5255-48b4-800c-80a23a2e429d' },
  { code: 'AND', name: 'Andernos-les-Bains', region: 'Ouest Sud-Ouest', groupId: '59a2fca1-32b2-477a-b8c5-35957df4c462' },
  { code: 'BIA', name: 'Biarritz', region: 'Ouest Sud-Ouest', groupId: 'e1cb9ba2-587c-4f65-954a-ecbf46d65f57' },
  { code: 'BRU', name: 'Bruges', region: 'Ouest Sud-Ouest', groupId: '0c69b213-eb4a-4e28-b6fb-b136a6980cbe' },
  { code: 'LAR', name: 'La Rochelle', region: 'Ouest Sud-Ouest', groupId: 'ae9aa502-f094-4f38-abb6-ce26c34b372e' },
  { code: 'LEM', name: 'Le Mans', region: 'Ouest Sud-Ouest', groupId: '1e3c3e28-8385-48db-b494-7e0f5b0de84e' },
  { code: 'LIB', name: 'Libourne', region: 'Ouest Sud-Ouest', groupId: '6591ed7c-3268-4f9e-9ace-581e665859be' },
  { code: 'LIM', name: 'Limoges', region: 'Ouest Sud-Ouest', groupId: '0c7af7c5-1b62-4138-8596-0b9cae0eb989' },
  { code: 'NAN', name: 'Nantes', region: 'Ouest Sud-Ouest', groupId: '134bb45a-ffd2-4254-9fc5-d74e7aca043f' },
  { code: 'REN', name: 'Rennes', region: 'Ouest Sud-Ouest', groupId: '14fe3315-13a7-40ac-83df-969c79ec01eb' },
  { code: 'SAN', name: 'Saint-Nazaire', region: 'Ouest Sud-Ouest', groupId: '1ce5e381-016e-4e08-9da2-9f7a8dec3540' },
  { code: 'BEL', name: 'Belleville-en-Beaujolais', region: 'Rhône Alpes', groupId: 'ef1ccf64-5100-4aaf-9d2f-faab2849a115' },
  { code: 'DIJ', name: 'Dijon', region: 'Rhône Alpes', groupId: '5f8146d4-e458-4da2-862d-4ee5b69b366c' },
  { code: 'GRE', name: 'Grenoble', region: 'Rhône Alpes', groupId: '552c1c63-a05f-4b9b-b883-17d8b99e3c31' },
  { code: 'BRO', name: 'Lyon', region: 'Rhône Alpes', groupId: '16df1161-8e8c-401c-9490-a122ce37f624' },
  { code: 'MBR', name: 'Montbrison', region: 'Rhône Alpes', groupId: 'b8b917e5-a22d-443f-b1c5-030a31484f78' },
  { code: 'SCH', name: 'Saint-Chamond', region: 'Rhône Alpes', groupId: '215a1294-0bbd-49ed-b2ff-334fde837637' },
  { code: 'STS', name: 'Saint-Etienne', region: 'Rhône Alpes', groupId: '95f2a75f-78b4-4224-bf7c-c5128438b0b2' },
  { code: 'VIE', name: 'Vienne', region: 'Rhône Alpes', groupId: 'b941ad4b-d28a-4ca9-9716-100df1cb19a0' },
  { code: 'VIF', name: 'Villefranche-sur-Saône', region: 'Rhône Alpes', groupId: '27d34502-9616-41eb-aa69-e39d05cf12d3' },
  { code: 'VIB', name: 'Villeurbanne', region: 'Rhône Alpes', groupId: '8e7727c2-d042-4f87-9e4b-f465865d599d' },
  { code: 'AIX', name: 'Aix-en-Provence', region: 'Sud Est', groupId: '87410147-2532-4b1e-b8d5-d0a20d798e69' },
  { code: 'ARL', name: 'Arles', region: 'Sud Est', groupId: '4648d5eb-b299-4d80-8395-833b023c6ddf' },
  { code: 'BSC', name: 'Bagnols-sur-Cèze', region: 'Sud Est', groupId: '27ed2b0f-7387-4877-ba75-2021c10d2487' },
  { code: 'CAN', name: 'Cannes', region: 'Sud Est', groupId: '7eb5741d-1624-4aa3-b87e-ddfc72d1fb6b' },
  { code: 'MAR', name: 'Marseille Prado', region: 'Sud Est', groupId: '1be0c27a-325b-4d04-a94d-460cc92865c4' },
  { code: 'MENT', name: 'Menton', region: 'Sud Est', groupId: 'a0544206-af0f-492f-bd27-b4e342cf1501' },
  { code: 'MON', name: 'Montpellier', region: 'Sud Est', groupId: '9cd1deeb-2ab2-4d74-a5ad-e139cc8b15cf' },
  { code: 'NIC', name: 'Nice', region: 'Sud Est', groupId: '4df1706c-e463-41e3-add8-c4a02acca37f' },
  { code: 'NIM', name: 'Nîmes', region: 'Sud Est', groupId: '4af68c5f-9d5e-4a34-8963-00998f5d2f84' },
  { code: 'TOU', name: 'Toulouse', region: 'Sud Est', groupId: '5b3468a3-aa5e-4bad-989f-2978859cbab2' },
]

// Ordre d'affichage des régions.
export const REGION_ORDER = ['IDF Est', 'IDF Ouest', 'Nord Normandie EST', 'Ouest Sud-Ouest', 'Rhône Alpes', 'Sud Est']

export function getAgencyGroups(): AgencyGroup[] {
  const raw = process.env['ONELA_AGENCY_GROUPS']
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as AgencyGroup[]
      if (Array.isArray(parsed) && parsed.every((g) => g.code && g.groupId && g.region)) return parsed
    } catch { /* JSON invalide → défaut */ }
  }
  return DEFAULT_AGENCY_GROUPS
}
