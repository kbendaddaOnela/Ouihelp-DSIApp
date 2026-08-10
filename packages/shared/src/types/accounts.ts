// Module "Création de comptes" — onboarding d'un nouvel arrivant ONELA.
//
// Flux (pendant la période de migration, MX toujours sur Exchange ONELA) :
//  1. Création du compte sur GOH/Ouihelp (prenom.nom@mig.onela.com) — SCIM → Google
//  2. Création d'un MailUser léger sur Exchange ONELA (prenom.nom@onela.com) dont
//     l'adresse externe pointe vers prenom.nom@mig.onela.com → l'entrant @onela.com
//     est routé vers Google, sans licence M365 ni mailbox à décommissionner.
//  3. Dès que le compte remonte dans Google via SCIM : bascule sur l'OU /onela.com
//     + alias prenom.nom@onela.com + send-as par défaut.

export type AccountStepStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped'

export type AssignmentType = 'Siège' | 'Agence'

// ── Données de référence ONELA (portées depuis l'ancienne app create_user) ──────

/** Services du Siège (Boulogne-Billancourt). */
export const ONELA_SERVICES: readonly string[] = [
  'DSI',
  'Directions Régionales',
  'Finance - ADV',
  'Finance - Comptabilité',
  'Finance - Contrôle de Gestion',
  'Marketing',
  'RH - Service Formation',
  'RH - Service Paie',
  'RH - Service Recrutement',
  'RH - Service Ressources Humaines',
  'Service Clients',
  'Service Commercial et Développement',
  'Services Généraux',
  'Service Qualité',
  'Service Relais Réseau',
  'Service Support Réseau',
] as const

/** Postes proposés en agence. */
export const AGENCY_JOB_TITLES: readonly string[] = [
  'APP Assistant RH',
  'APP Responsable de Secteur',
  "Responsable d'Agence",
  "Responsable d'Agence Adjoint(e)",
  "Assistant(e) d'Agence",
  'Responsable de Secteur',
  'Responsable de Secteur Référente',
  'Assistant(e) Responsable de Secteur',
  'Stagiaire Responsable de Secteur',
] as const

export interface AgencyInfo {
  /** Trigramme du service (department dans Entra), ex. "AIX". */
  service: string
  region: string
  adresse: string
  cp: string
  ville: string
}

/** Adresse du Siège (affectation "Siège"). */
export const HEAD_OFFICE = {
  officeLocation: 'Siège',
  streetAddress: '35 Rue de Paris',
  postalCode: '92100',
  city: 'Boulogne-Billancourt',
} as const

/**
 * Régions ONELA (découpage interne, différent des régions administratives françaises).
 * Sert de liste de choix pour l'édition d'une agence.
 */
export const ONELA_REGIONS: readonly string[] = [
  'NORD NORMANDIE EST',
  'IDF OUEST',
  'IDF EST',
  'OUEST SUD-OUEST',
  'RHONE-ALPES',
  'SUD-EST',
] as const

/**
 * Les 66 agences ONELA (données de SEED initiales — la source de vérité en prod est
 * la table `agencies`, éditable via l'UI). `region` = découpage ONELA (cf. ONELA_REGIONS).
 */
export const ONELA_AGENCIES: Record<string, AgencyInfo> = {
  'Aix-en-Provence': { service: 'AIX', region: 'SUD-EST', adresse: '373 avenue Jean-Paul Coste - Résidence Le Bel Ormeau', cp: '13100', ville: 'Aix-en-Provence' },
  'Andernos-les-Bains': { service: 'AND', region: 'OUEST SUD-OUEST', adresse: '121 boulevard de la République', cp: '33510', ville: 'Andernos-les-Bains' },
  'Antony': { service: 'ANT', region: 'IDF OUEST', adresse: "3 avenue Jeanne d'Arc", cp: '92160', ville: 'Antony' },
  'Argenteuil': { service: 'ARG', region: 'IDF OUEST', adresse: '64 avenue de Stalingrad', cp: '95100', ville: 'Argenteuil' },
  'Arles': { service: 'ARL', region: 'SUD-EST', adresse: '15 rue La Bruyère', cp: '13200', ville: 'Arles' },
  'Armentières': { service: 'ARM', region: 'NORD NORMANDIE EST', adresse: '117 quai de Beauvais', cp: '59280', ville: 'Armentières' },
  'Bagnols-sur-Cèze': { service: 'BSC', region: 'SUD-EST', adresse: '6 chemin du cartonnage', cp: '30200', ville: 'Bagnols-sur-Cèze' },
  'Belleville-en-Beaujolais': { service: 'BEL', region: 'RHONE-ALPES', adresse: '1 rue Joseph Pillard', cp: '69220', ville: 'Belleville-en-Beaujolais' },
  'Biarritz': { service: 'BIA', region: 'OUEST SUD-OUEST', adresse: '4 rue du manège', cp: '64200', ville: 'Biarritz' },
  'Bruges': { service: 'BRU', region: 'OUEST SUD-OUEST', adresse: "24 avenue de l'Europe", cp: '33520', ville: 'Bruges' },
  'Caen': { service: 'CAE', region: 'NORD NORMANDIE EST', adresse: '34 avenue du Six Juin', cp: '14000', ville: 'Caen' },
  'Cannes': { service: 'CAN', region: 'SUD-EST', adresse: '250 avenue de Grasse', cp: '06400', ville: 'Cannes' },
  'Champs-sur-Marne': { service: 'CSM', region: 'IDF EST', adresse: '14 rue Albert Einstein', cp: '77420', ville: 'Champs-sur-Marne' },
  'Chilly-Mazarin': { service: 'CHI', region: 'IDF EST', adresse: '38 rue François Mouthon', cp: '91380', ville: 'Chilly-Mazarin' },
  'Clichy-sous-Bois': { service: 'CLI', region: 'IDF EST', adresse: '2 allée de la Fosse-Maussoin', cp: '93390', ville: 'Clichy-sous-Bois' },
  'Croix': { service: 'CRX', region: 'NORD NORMANDIE EST', adresse: '19 rue de la Gare', cp: '59170', ville: 'Croix' },
  'Dieppe': { service: 'DIE', region: 'NORD NORMANDIE EST', adresse: '10 rue Pierre Pocholle', cp: '76200', ville: 'Dieppe' },
  'Dijon': { service: 'DIJ', region: 'RHONE-ALPES', adresse: '25 rue Angélique Ducoudray', cp: '21000', ville: 'Dijon' },
  'Elbeuf': { service: 'ELB', region: 'NORD NORMANDIE EST', adresse: '43 rue du Général de Gaulle', cp: '76500', ville: 'Elbeuf' },
  'Evreux': { service: 'EVR', region: 'NORD NORMANDIE EST', adresse: '24 rue Franklin Roosevelt', cp: '27000', ville: 'Evreux' },
  'Fontainebleau': { service: 'FON', region: 'IDF EST', adresse: '32 rue de la cloche', cp: '77300', ville: 'Fontainebleau' },
  'Gagny': { service: 'GAG', region: 'IDF EST', adresse: '3 rue du général Leclerc', cp: '93220', ville: 'Gagny' },
  'Grenoble': { service: 'GRE', region: 'RHONE-ALPES', adresse: '8 rue Général Ferrié', cp: '38100', ville: 'Grenoble' },
  'Hazebrouck': { service: 'HAZ', region: 'NORD NORMANDIE EST', adresse: '2 rue de Lille', cp: '59190', ville: 'Hazebrouck' },
  'Joeuf': { service: 'JOE', region: 'NORD NORMANDIE EST', adresse: '148 rue de Franchepré', cp: '54240', ville: 'Joeuf' },
  'La Garenne-Colombes': { service: 'COU', region: 'IDF OUEST', adresse: "10 rue Dumont D'Urville", cp: '92250', ville: 'La Garenne-Colombes' },
  'La Rochelle': { service: 'LAR', region: 'OUEST SUD-OUEST', adresse: '54 avenue Edmond Grasset', cp: '17440', ville: 'Aytré' },
  'Le Mans': { service: 'LEM', region: 'OUEST SUD-OUEST', adresse: '38 bis avenue Bollée', cp: '72000', ville: 'Le Mans' },
  'Libourne': { service: 'LIB', region: 'OUEST SUD-OUEST', adresse: '5 rue de Logrono', cp: '33500', ville: 'Libourne' },
  'Lille': { service: 'LIL', region: 'NORD NORMANDIE EST', adresse: '191 rue Colbert', cp: '59000', ville: 'Lille' },
  'Limoges': { service: 'LIM', region: 'OUEST SUD-OUEST', adresse: '19 Boulevard Louis Blanc', cp: '87000', ville: 'Limoges' },
  'Lyon': { service: 'BRO', region: 'RHONE-ALPES', adresse: '2 place du Général Brosset', cp: '69006', ville: 'Lyon' },
  'Marseille Prado': { service: 'MAR', region: 'SUD-EST', adresse: '2 place du Général Brosset', cp: '13008', ville: 'Marseille' },
  'Melun': { service: 'DAM', region: 'IDF EST', adresse: '60 rue St Barthélémy', cp: '77000', ville: 'Melun' },
  'Menton': { service: 'MENT', region: 'SUD-EST', adresse: '7 cours Georges V', cp: '06500', ville: 'Menton' },
  'Metz': { service: 'MET', region: 'NORD NORMANDIE EST', adresse: '1 place Raymond Mondon', cp: '57000', ville: 'Metz' },
  'Montbrison': { service: 'MBR', region: 'RHONE-ALPES', adresse: '1 place des Comtes du Forez', cp: '42600', ville: 'Montbrison' },
  'Montpellier': { service: 'MON', region: 'SUD-EST', adresse: '15 boulevard Louis Blanc', cp: '34000', ville: 'Montpellier' },
  'Nantes': { service: 'NAN', region: 'OUEST SUD-OUEST', adresse: '173 rue Paul Bellamy', cp: '44000', ville: 'Nantes' },
  'Neuilly-sur-Seine': { service: 'NEU', region: 'IDF OUEST', adresse: '103 avenue Charles de Gaulle', cp: '92200', ville: 'Neuilly-sur-Seine' },
  'Nice': { service: 'NIC', region: 'SUD-EST', adresse: '28 avenue Auber', cp: '06000', ville: 'Nice' },
  'Nîmes': { service: 'NIM', region: 'SUD-EST', adresse: '23 rue Briçonnet', cp: '30000', ville: 'Nîmes' },
  'Noisy-le-Sec': { service: 'NOI', region: 'IDF EST', adresse: '94 ter rue Jean Jaurès', cp: '93130', ville: 'Noisy-le-Sec' },
  'Orléans': { service: 'ORL', region: 'IDF OUEST', adresse: '1 rue de Bourgogne', cp: '45000', ville: 'Orléans' },
  'Paris 11': { service: 'PAR', region: 'IDF OUEST', adresse: '6 rue Emile Lepeu', cp: '75011', ville: 'Paris' },
  'Paris 13': { service: 'PA13', region: 'IDF OUEST', adresse: "164 rue Jeanne d'Arc", cp: '75013', ville: 'Paris' },
  'Paris 16': { service: 'PA16', region: 'IDF OUEST', adresse: '74-76 rue Michel Ange', cp: '75016', ville: 'Paris' },
  'Reims': { service: 'REI', region: 'NORD NORMANDIE EST', adresse: '49 rue Thiers', cp: '51100', ville: 'Reims' },
  'Rennes': { service: 'REN', region: 'OUEST SUD-OUEST', adresse: '32 rue du Docteur Francis Joly', cp: '35000', ville: 'Rennes' },
  'Rouen': { service: 'ROU', region: 'NORD NORMANDIE EST', adresse: '26 rue Saint Eloi', cp: '76000', ville: 'Rouen' },
  'Saint-Chamond': { service: 'SCH', region: 'RHONE-ALPES', adresse: '8 boulevard François Delay', cp: '42400', ville: 'Saint-Chamond' },
  'Saint-Etienne': { service: 'STS', region: 'RHONE-ALPES', adresse: '12 boulevard de la Palle', cp: '42100', ville: 'Saint-Etienne' },
  'Saint-Germain-en-Laye': { service: 'SAI', region: 'IDF OUEST', adresse: '13 B Rue Danès de Montardat', cp: '78100', ville: 'Saint-Germain-en-Laye' },
  'Saint-Maur-des-Fossés': { service: 'STM', region: 'IDF EST', adresse: '12 boulevard Rabelais', cp: '94100', ville: 'Saint-Maur-des-Fossés' },
  'Saint-Nazaire': { service: 'SAN', region: 'OUEST SUD-OUEST', adresse: '27 boulevard de la Renaissance', cp: '44600', ville: 'Saint-Nazaire' },
  'Savigny-sur-Orge': { service: 'GIF', region: 'IDF EST', adresse: '207 boulevard Aristide Briand', cp: '91600', ville: 'Savigny-sur-Orge' },
  'Strasbourg': { service: 'STR', region: 'NORD NORMANDIE EST', adresse: '33 rue du Fossé des Treize', cp: '67000', ville: 'Strasbourg' },
  'Thiais': { service: 'THI', region: 'IDF EST', adresse: '3 rue de la résistance - Centre commercial Thiais Village', cp: '94320', ville: 'Thiais' },
  'Toulouse': { service: 'TOU', region: 'SUD-EST', adresse: '159 grande rue Saint Michel', cp: '31400', ville: 'Toulouse' },
  'Valenciennes': { service: 'VAL', region: 'NORD NORMANDIE EST', adresse: '14 place du 8 mai 1945', cp: '59300', ville: 'Valenciennes' },
  'Versailles': { service: 'VER', region: 'IDF OUEST', adresse: "32 rue de l'orangerie", cp: '78000', ville: 'Versailles' },
  'Vienne': { service: 'VIE', region: 'RHONE-ALPES', adresse: '30 Avenue du Général Leclerc Espace ST germain, Bâtiment Apollo B', cp: '38200', ville: 'Vienne' },
  'Villefranche-sur-Saône': { service: 'VIF', region: 'RHONE-ALPES', adresse: '3 rue de Tarare', cp: '69400', ville: 'Villefranche-sur-Saône' },
  'Villeurbanne': { service: 'VIB', region: 'RHONE-ALPES', adresse: '12 rue Branly', cp: '69100', ville: 'Villeurbanne' },
  'Vincennes': { service: 'VIN', region: 'IDF EST', adresse: '14 allée Georges Pompidou', cp: '94300', ville: 'Vincennes' },
  'Yvetot': { service: 'YVE', region: 'NORD NORMANDIE EST', adresse: '6 rue Pierre Varin, Immeuble Jura appt 3', cp: '76190', ville: 'Yvetot' },
}

// ── Agences (persistées en base, éditables) ─────────────────────────────────────

export interface Agency {
  id: string
  /** Nom = officeLocation (ex. "Montpellier"). */
  name: string
  /** Trigramme = department dans Entra (ex. "MON"). */
  trigramme: string
  /** Région ONELA (cf. ONELA_REGIONS). */
  region: string
  address: string
  postalCode: string
  city: string
}

export type AgencyInput = Omit<Agency, 'id'>

export interface AgenciesResponse {
  agencies: Agency[]
}

// ── Manager (autocomplétion) ────────────────────────────────────────────────────

export interface ManagerCandidate {
  id: string
  displayName: string
  upn: string
  jobTitle: string | null
}

export interface SearchManagersResponse {
  managers: ManagerCandidate[]
}

// ── Requête de création ─────────────────────────────────────────────────────────

export interface CreateAccountRequest {
  firstName: string
  lastName: string
  displayName: string
  /** Préfixe email (partie locale), ex. "jean.dupont". */
  emailPrefix: string
  /** Domaine, ex. "@onela.com". */
  emailDomain: string
  assignmentType: AssignmentType
  /** Service (Siège) ou trigramme (Agence). */
  department: string
  jobTitle: string
  /** UPN GOH du manager (optionnel). */
  managerUpn: string | null
  /** Nom de l'agence (Agence) ou "Siège". */
  officeLocation: string
  /** Région (Agence). */
  state: string | null
  streetAddress: string | null
  postalCode: string | null
  city: string | null
  /** Mot de passe initial du compte GOH. */
  password: string
  /** Forcer le changement de mot de passe au premier login. */
  forceChangePassword: boolean
}

// ── Enregistrement (suivi) ────────────────────────────────────────────────────

export interface AccountCreationRecord {
  id: string
  firstName: string
  lastName: string
  displayName: string
  onelaUpn: string
  gohUpn: string
  gohUserId: string | null
  routingAddress: string
  assignmentType: AssignmentType
  department: string | null
  jobTitle: string | null
  managerUpn: string | null
  officeLocation: string | null
  state: string | null
  streetAddress: string | null
  postalCode: string | null
  city: string | null
  tempPassword: string | null
  stepCreateGoh: AccountStepStatus
  stepSetAttributes: AccountStepStatus
  stepOnelaRouting: AccountStepStatus
  stepGoogleProvision: AccountStepStatus
  stepOuMove: AccountStepStatus
  stepNewFormat: AccountStepStatus
  stepSendAs: AccountStepStatus
  stepContactsOnela: AccountStepStatus
  errorDetails: string | null
  initiatedBy: string
  createdAt: string
  updatedAt: string
}

export interface CreateAccountResponse {
  account: AccountCreationRecord
}

export interface AccountHistoryResponse {
  accounts: AccountCreationRecord[]
  total: number
}
