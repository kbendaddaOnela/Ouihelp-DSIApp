// Coordonnées des agences ONELA (depuis le CSV Ximi) pour la signature : adresse
// + ville + téléphone fixe, par code agence. Surchargeable via ONELA_AGENCY_CONTACTS (JSON).

export interface AgencyContact { code: string; site: string; adresse: string; cpVille: string; tel: string }

const DEFAULT_AGENCY_CONTACTS: AgencyContact[] = [
  { code: 'AIX' , site: 'Aix-en-Provence' , adresse: '373 avenue Jean-Paul Coste - Résidence Le Bel Ormeau' , cpVille: '13100 Aix-en-Provence' , tel: '04 84 47 00 07' },
  { code: 'AND' , site: 'Andernos-les-Bains' , adresse: '121 boulevard de la République' , cpVille: '33510 Andernos-les-Bains' , tel: '05 64 10 00 12' },
  { code: 'ANT' , site: 'Antony' , adresse: '3 avenue Jeanne d\'Arc' , cpVille: '92160 Antony' , tel: '01 84 01 11 32' },
  { code: 'ARG' , site: 'Argenteuil' , adresse: '64 avenue de Stalingrad' , cpVille: '95100 Argenteuil' , tel: '01 84 28 00 13' },
  { code: 'ARM' , site: 'Armentières' , adresse: '117 quai de Beauvais' , cpVille: '59280 Armentières' , tel: '03 66 06 01 32' },
  { code: 'BSC' , site: 'Bagnols-sur-Cèze' , adresse: '6 chemin du cartonnage' , cpVille: '30200 Bagnols-sur-Cèze' , tel: '04 11 94 01 49' },
  { code: 'BEL' , site: 'Belleville-en-Beaujolais' , adresse: '1 rue Joseph Pillard' , cpVille: '69220 Belleville-en-Beaujolais' , tel: '04 74 68 49 51' },
  { code: 'BIA' , site: 'Biarritz' , adresse: '4 rue du Manège' , cpVille: '64200 Biarritz' , tel: '05 64 19 00 19' },
  { code: 'BOU' , site: 'Boulogne-Billancourt' , adresse: '19 rue des 4 cheminées' , cpVille: '92100 Boulogne-Billancourt' , tel: '01 84 01 11 31' },
  { code: 'BRU' , site: 'Bruges' , adresse: '24 avenue de l\'Europe' , cpVille: '33520 Bruges' , tel: '05 64 10 00 49' },
  { code: 'CAE' , site: 'Caen' , adresse: '34 avenue du Six Juin' , cpVille: '14000 Caen' , tel: '02 31 78 05 55' },
  { code: 'CAN' , site: 'Cannes' , adresse: '250 avenue de Grasse' , cpVille: '06400 Cannes' , tel: '04 93 94 11 92' },
  { code: 'CSM' , site: 'Champs-sur-Marne' , adresse: '14 rue Albert Einstein' , cpVille: '77420 Champs-sur-Marne' , tel: '01 64 62 08 59' },
  { code: 'CHI' , site: 'Chilly-Mazarin' , adresse: '38 rue François Mouthon' , cpVille: '91380 Chilly-Mazarin' , tel: '01 64 48 64 79' },
  { code: 'CLI' , site: 'Clichy-sous-Bois' , adresse: '2 allée de la Fosse-Maussoin' , cpVille: '93390 Clichy-sous-Bois' , tel: '01 84 03 00 89' },
  { code: 'CRX' , site: 'Croix' , adresse: '19 rue de la Gare' , cpVille: '59170 Croix' , tel: '03 66 06 01 27' },
  { code: 'DIE' , site: 'Dieppe' , adresse: '10 rue Pierre Pocholle' , cpVille: '76200 Dieppe' , tel: '02 35 83 14 84' },
  { code: 'DIJ' , site: 'Dijon' , adresse: '25 rue Angélique Ducoudray' , cpVille: '21000 Dijon' , tel: '03 80 45 01 96' },
  { code: 'ELB' , site: 'Elbeuf' , adresse: '43 rue du Général de Gaulle' , cpVille: '76500 Elbeuf' , tel: '02 35 77 61 60' },
  { code: 'EVR' , site: 'Evreux' , adresse: '24 rue Franklin Roosevelt' , cpVille: '27000 Evreux' , tel: '02 78 94 04 73' },
  { code: 'FON' , site: 'Fontainebleau' , adresse: '32 rue de la cloche' , cpVille: '77300 Fontainebleau' , tel: '01 84 26 05 19' },
  { code: 'GAG' , site: 'Gagny' , adresse: '3 rue du général Leclerc' , cpVille: '93220 Gagny' , tel: '01 41 53 09 29' },
  { code: 'GRE' , site: 'Grenoble' , adresse: '8 rue Général Ferrié' , cpVille: '38100 Grenoble' , tel: '04 85 19 00 34' },
  { code: 'HAZ' , site: 'Hazebrouck' , adresse: '2 rue de Lille' , cpVille: '59190 Hazebrouck' , tel: '03 74 03 01 51' },
  { code: 'JOE' , site: 'Joeuf' , adresse: '148 rue de Franchepré' , cpVille: '54240 Joeuf' , tel: '03 82 22 98 74' },
  { code: 'COU' , site: 'La Garenne-Colombes' , adresse: '10 rue Dumont D\'Urville' , cpVille: '92250 La Garenne-Colombes' , tel: '01 84 02 11 17' },
  { code: 'LAR' , site: 'La Rochelle' , adresse: '54 avenue Edmond Grasset' , cpVille: '17440 Aytré' , tel: '05 86 08 01 47' },
  { code: 'LEM' , site: 'Le Mans' , adresse: '38 bis avenue Bollée' , cpVille: '72000 Le Mans' , tel: '02 52 22 01 05' },
  { code: 'LIB' , site: 'Libourne' , adresse: '16 avenue de la ROUDET' , cpVille: '33500 Libourne' , tel: '05 64 10 08 29' },
  { code: 'LIL' , site: 'Lille' , adresse: '191 rue Colbert' , cpVille: '59000 Lille' , tel: '03 74 02 02 79' },
  { code: 'LIM' , site: 'Limoges' , adresse: '19 Boulevard Louis Blanc' , cpVille: '87000 Limoges' , tel: '05 55 71 00 02' },
  { code: 'BRO' , site: 'Lyon' , adresse: '2 place du Général Brosset' , cpVille: '69006 Lyon' , tel: '04 72 75 96 45' },
  { code: 'MAR' , site: 'Marseille Prado' , adresse: '31 boulevard de Maillane' , cpVille: '13008 Marseille' , tel: '04 91 77 55 20' },
  { code: 'DAM' , site: 'Melun' , adresse: '60 rue St Barthélémy' , cpVille: '77000 Melun' , tel: '01 84 26 00 76' },
  { code: 'MENT' , site: 'Menton' , adresse: '7 cours Georges V' , cpVille: '06500 Menton' , tel: '04 93 28 35 80' },
  { code: 'MET' , site: 'Metz' , adresse: '1 place Raymond Mondon' , cpVille: '57000 Metz' , tel: '03 72 43 00 30' },
  { code: 'MBR' , site: 'Montbrison' , adresse: '1 place des Comtes du Forez' , cpVille: '42600 Montbrison' , tel: '04 77 76 69 87' },
  { code: 'MON' , site: 'Montpellier' , adresse: '15 boulevard Louis Blanc' , cpVille: '34000 Montpellier' , tel: '04 11 95 01 18' },
  { code: 'NAN' , site: 'Nantes' , adresse: '173 rue Paul Bellamy' , cpVille: '44000 Nantes' , tel: '02 52 20 02 16' },
  { code: 'NEU' , site: 'Neuilly-sur-Seine' , adresse: '103 avenue Charles de Gaulle' , cpVille: '92200 Neuilly-sur-Seine' , tel: '01 41 92 93 30' },
  { code: 'NIC' , site: 'Nice' , adresse: '28 avenue Auber' , cpVille: '06000 Nice' , tel: '04 89 24 41 02' },
  { code: 'NIM' , site: 'Nîmes' , adresse: '23 rue Briçonnet' , cpVille: '30000 Nîmes' , tel: '04 11 94 00 61' },
  { code: 'NOI' , site: 'Noisy-le-sec' , adresse: '94 ter rue Jean Jaurès' , cpVille: '93130 Noisy-le-sec' , tel: '01 48 40 15 75' },
  { code: 'ORL' , site: 'Orléans' , adresse: '1 rue de Bourgogne' , cpVille: '45000 Orléans' , tel: '02 46 72 00 54' },
  { code: 'PAR' , site: 'Paris 11' , adresse: '6 rue Emile Lepeu' , cpVille: '75011 Paris' , tel: '01 83 79 16 88' },
  { code: 'PA13' , site: 'Paris 13' , adresse: '164 rue Jeanne d\'Arc' , cpVille: '75013 Paris' , tel: '01 53 61 06 06' },
  { code: 'PA16' , site: 'Paris 16' , adresse: '74-76 rue Michel Ange' , cpVille: '75016 Paris' , tel: '01 53 84 20 27' },
  { code: 'REI' , site: 'Reims' , adresse: '49 rue Thiers' , cpVille: '51100 Reims' , tel: '03 52 62 00 41' },
  { code: 'REN' , site: 'Rennes' , adresse: '32 rue du Docteur Francis Joly' , cpVille: '35000 Rennes' , tel: '02 99 30 30 80' },
  { code: 'ROU' , site: 'Rouen' , adresse: '26 rue Saint Eloi' , cpVille: '76000 Rouen' , tel: '02 32 10 12 19' },
  { code: 'SCH' , site: 'Saint-Chamond' , adresse: '8 boulevard François Delay' , cpVille: '42400 Saint-Chamond' , tel: '04 77 22 68 42' },
  { code: 'STS' , site: 'Saint-Etienne' , adresse: '12 boulevard de la Palle' , cpVille: '42100 Saint-Etienne' , tel: '04 77 92 15 89' },
  { code: 'SAI' , site: 'Saint-Germain-en-Laye' , adresse: '13 B Rue Danès de Montardat' , cpVille: '78100 Saint-Germain-en-Laye' , tel: '01 30 08 12 68' },
  { code: 'STM' , site: 'Saint-Maur-des-Fossés' , adresse: '12 boulevard Rabelais' , cpVille: '94100 Saint-Maur-des-Fossés' , tel: '01 84 04 02 06' },
  { code: 'SAN' , site: 'Saint-Nazaire' , adresse: '27 boulevard de la Renaissance' , cpVille: '44600 Saint-Nazaire' , tel: '02 40 62 53 17' },
  { code: 'GIF' , site: 'Savigny-sur-Orge' , adresse: '207 boulevard Aristide Briand' , cpVille: '91600 Savigny-sur-Orge' , tel: '01 83 61 62 58' },
  { code: 'STR' , site: 'Strasbourg' , adresse: '33 rue du Fossé des Treize' , cpVille: '67000 Strasbourg' , tel: '03 67 22 02 13' },
  { code: 'THI' , site: 'Thiais' , adresse: '3 rue de la résistance - Centre commercial Thiais Village' , cpVille: '94320 Thiais' , tel: '01 45 60 50 54' },
  { code: 'TOU' , site: 'Toulouse' , adresse: '159 grande rue Saint Michel' , cpVille: '31400 Toulouse' , tel: '05 32 11 07 52' },
  { code: 'VAL' , site: 'Valenciennes' , adresse: '14 place du 8 mai 1945' , cpVille: '59300 Valenciennes' , tel: '03 74 02 99 87' },
  { code: 'VER' , site: 'Versailles' , adresse: '32 rue de l\'orangerie' , cpVille: '78000 Versailles' , tel: '01 84 27 03 95' },
  { code: 'VIE' , site: 'Vienne' , adresse: '30 Avenue du Général Leclerc Espace ST germain, Bâtiment Apollo B' , cpVille: '38200 Vienne' , tel: '04 74 79 93 54' },
  { code: 'VIF' , site: 'Villefranche-sur-Saône' , adresse: '3 rue de Tarare' , cpVille: '69400 Villefranche-sur-Saône' , tel: '04 74 03 57 72' },
  { code: 'VIB' , site: 'Villeurbanne' , adresse: '43 rue Colin' , cpVille: '69100 Villeurbanne' , tel: '04 37 43 35 20' },
  { code: 'VIN' , site: 'Vincennes' , adresse: '14 allée Georges Pompidou' , cpVille: '94300 Vincennes' , tel: '01 43 98 12 29' },
  { code: 'YVE' , site: 'Yvetot' , adresse: '6 rue Pierre Varin, Immeuble Jura appt 3' , cpVille: '76190 Yvetot' , tel: '02 78 94 02 75' },
]

export function getAgencyContacts(): AgencyContact[] {
  const raw = process.env['ONELA_AGENCY_CONTACTS']
  if (raw && raw.trim()) {
    try { const p = JSON.parse(raw) as AgencyContact[]; if (Array.isArray(p) && p.every((x) => x.code)) return p } catch { /* défaut */ }
  }
  return DEFAULT_AGENCY_CONTACTS
}

export function agencyContactByCode(): Map<string, AgencyContact> {
  return new Map(getAgencyContacts().map((a) => [a.code.toUpperCase(), a]))
}
