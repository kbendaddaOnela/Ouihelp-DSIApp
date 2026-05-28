import { Hono } from 'hono'
import { eq, and, like, or, asc, gte, lte } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { authMiddleware } from '../../middleware/auth'
import { loadUserRole, requirePermission } from '../../middleware/rbac'
import type { RbacVariables } from '../../middleware/rbac'
import { getDb } from '../../db/index'
import { budgetItems } from './schema'

export const budgetRouter = new Hono<{ Variables: RbacVariables }>()

// ── Seed temporaire (à retirer après usage) ────────────────────────────────────
const SEED_TOKEN = 'a37e5b31aac6a8abb95bd833e4daf6dc52aa61b0'
budgetRouter.get('/seed-budget', async (c) => {
  if (c.req.query('token') !== SEED_TOKEN) return c.json({ error: 'Unauthorized' }, 401)
  const db = getDb()
  const now = new Date()

  function computeStatus(end: string | null): 'active' | 'expiring_soon' | 'expired' | 'cancelled' {
    if (!end) return 'active'
    const today = new Date().toISOString().slice(0, 10)
    const in90 = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)
    if (end < today) return 'expired'
    if (end <= in90) return 'expiring_soon'
    return 'active'
  }

  const CD = 'Colisee Domicile' as const
  const ONS = 'ONELA Services' as const

  const ITEMS = [
    { name: 'Abonnement accès internet des agences (NHS PACA)', vendor: 'Bouygues Telecom', category: 'telecom', quantity: 1, unitCost: '92.78', amount: '92.78', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'NHS PACA', notes: 'Compte BTE sous entité CDM : 8.14019.13' },
    { name: 'Licence Cloud Cisco Meraki', vendor: 'Cisco Meraki', category: 'cloud', quantity: 1, unitCost: null, amount: '0.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: "Offert gratuitement par BT (ancien prix : 2 000 €)" },
    { name: 'Abonnement Téléphonie RingCentral', vendor: 'Sincrone', category: 'telecom', quantity: 370, unitCost: '21.45', amount: '7936.50', billingCycle: 'quarterly', contractStart: '2025-10-01', contractEnd: '2028-10-14', billingEntity: ONS, notes: "Charge semestrielle : 370 × 42,90 €" },
    { name: "Abonnement RingCentral - Groupement d'appel", vendor: 'Sincrone', category: 'telecom', quantity: 370, unitCost: '0.96', amount: '353.35', billingCycle: 'quarterly', contractStart: '2025-10-01', contractEnd: '2028-10-14', billingEntity: ONS, notes: null },
    { name: 'Abonnement RingCentral - Support utilisateurs', vendor: 'Sincrone', category: 'telecom', quantity: 12, unitCost: '370.00', amount: '4440.00', billingCycle: 'annual', contractStart: '2025-10-01', contractEnd: '2028-10-14', billingEntity: ONS, notes: 'Engagement 3 ans payé en 2025 : facture 13 320 € réglée nov 2025' },
    { name: 'TeamViewer - Prise de main à distance (CDM)', vendor: 'TeamViewer', category: 'saas', quantity: 1, unitCost: null, amount: '0.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: '1 licence Sabar — payée CB Carine — obsolète (remis à 0)' },
    { name: 'TeamViewer - Prise de main à distance (ONS)', vendor: 'TeamViewer', category: 'saas', quantity: 1, unitCost: '1965.08', amount: '1965.08', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: ONS, notes: '1 licence 3 utilisateurs (Lucianne + Mathilde) — payée CB Carine' },
    { name: 'Licences Microsoft 365 Apps — Admin Agences', vendor: 'Econocom', category: 'license', quantity: 260, unitCost: '9.10', amount: '2366.00', billingCycle: 'monthly', contractStart: '2024-01-01', contractEnd: '2025-04-22', billingEntity: CD, notes: 'Licences pour administratifs BALM + NHS + NHS PACA' },
    { name: 'Licences Microsoft 365 Apps — Admin Siège', vendor: 'Econocom', category: 'license', quantity: 65, unitCost: '9.10', amount: '591.50', billingCycle: 'monthly', contractStart: '2024-01-01', contractEnd: '2025-04-22', billingEntity: ONS, notes: 'Licences pour administratifs ONS' },
    { name: 'Licences Microsoft 365 E3', vendor: 'DELETEC', category: 'license', quantity: 100, unitCost: '30.38', amount: '3038.00', billingCycle: 'monthly', contractStart: '2025-04-01', contractEnd: null, billingEntity: ONS, notes: 'Licences pour administratifs ONS' },
    { name: 'Licences Microsoft 365 Teams EEA', vendor: 'DELETEC', category: 'license', quantity: 100, unitCost: '4.38', amount: '438.00', billingCycle: 'monthly', contractStart: '2025-04-01', contractEnd: null, billingEntity: ONS, notes: 'Licences pour administratifs ONS' },
    { name: 'Licences Microsoft Defender for Office 365', vendor: 'DELETEC', category: 'license', quantity: 100, unitCost: '1.60', amount: '160.00', billingCycle: 'monthly', contractStart: '2025-04-01', contractEnd: null, billingEntity: ONS, notes: 'Licences pour administratifs ONS' },
    { name: 'Licences Microsoft 365 Business Premium', vendor: 'DELETEC', category: 'license', quantity: 300, unitCost: '17.17', amount: '5151.00', billingCycle: 'monthly', contractStart: '2025-04-01', contractEnd: null, billingEntity: ONS, notes: 'Licences pour administratifs ONS' },
    { name: 'Licences Microsoft 365 - Entra ID P1', vendor: 'DELETEC', category: 'license', quantity: 1, unitCost: '8.20', amount: '8.20', billingCycle: 'monthly', contractStart: '2025-04-01', contractEnd: '2025-04-22', billingEntity: ONS, notes: 'Licences pour administratifs ONS' },
    { name: 'Outil ITSM TopDesk (x6 utilisateurs)', vendor: 'TopDesk', category: 'saas', quantity: 6, unitCost: '90.00', amount: '540.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: '4 utilisateurs DSI + 2 utilisateurs Paie' },
    { name: 'Augmentation tarifaire ITSM TopDesk (+5%)', vendor: 'TopDesk', category: 'saas', quantity: 6, unitCost: '9.00', amount: '54.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: '+5% avec engagement contractuel sur 3 ans' },
    { name: 'Augmentation tarifaire ITSM TopDesk 2026', vendor: 'TopDesk', category: 'saas', quantity: 6, unitCost: '3.96', amount: '23.76', billingCycle: 'monthly', contractStart: '2025-11-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Abonnement antivirus WithSecure', vendor: 'Koesio', category: 'saas', quantity: 450, unitCost: '7.28', amount: '3276.00', billingCycle: 'annual', contractStart: '2024-06-01', contractEnd: '2025-06-30', billingEntity: CD, notes: null },
    { name: 'Licences Webex Meeting x30 utilisateurs', vendor: 'Exaprobe', category: 'saas', quantity: 30, unitCost: '168.78', amount: '5063.40', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: '2025-06-25', billingEntity: CD, notes: 'Sera remplacé par Teams' },
    { name: 'Licences Webex Meeting x2 systèmes de visio', vendor: 'Exaprobe', category: 'saas', quantity: 2, unitCost: '225.21', amount: '450.42', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: '2025-06-25', billingEntity: CD, notes: 'Sera remplacé par Teams' },
    { name: 'Maintenance Webex Pack Basic', vendor: 'Exaprobe', category: 'support', quantity: 1, unitCost: '98.44', amount: '98.44', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: '2025-06-25', billingEntity: CD, notes: 'Sera remplacé par Teams' },
    { name: 'Abonnements Ximi - ONS (anciens)', vendor: 'Xelya', category: 'saas', quantity: 1, unitCost: '200.00', amount: '200.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: '2025-10-30', billingEntity: ONS, notes: 'Basé sur relevé 10/2024 — remplacé nov 2025' },
    { name: 'Abonnements Ximi - BALM (anciens)', vendor: 'Xelya', category: 'saas', quantity: 1, unitCost: '30000.00', amount: '30000.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: '2025-10-30', billingEntity: 'BALM', notes: 'Basé sur relevé 10/2024 — remplacé nov 2025' },
    { name: 'Abonnements Ximi - NHS (anciens)', vendor: 'Xelya', category: 'saas', quantity: 1, unitCost: '8500.00', amount: '8500.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: '2025-10-30', billingEntity: 'NHS', notes: 'Basé sur relevé 10/2024 — remplacé nov 2025' },
    { name: 'Abonnements Ximi - NHS PACA (anciens)', vendor: 'Xelya', category: 'saas', quantity: 1, unitCost: '1100.00', amount: '1100.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: '2025-10-30', billingEntity: 'NHS PACA', notes: 'Basé sur relevé 10/2024 — remplacé nov 2025' },
    { name: 'Abonnements Ximi - ONS', vendor: 'Xelya', category: 'saas', quantity: 1, unitCost: '211.00', amount: '211.00', billingCycle: 'monthly', contractStart: '2025-11-01', contractEnd: null, billingEntity: ONS, notes: 'Basé sur relevé 10/2024 avec application Syntec' },
    { name: 'Abonnements Ximi - BALM', vendor: 'Xelya', category: 'saas', quantity: 1, unitCost: '22000.00', amount: '22000.00', billingCycle: 'monthly', contractStart: '2025-11-01', contractEnd: null, billingEntity: 'BALM', notes: 'Basé sur relevé 10/2024 avec application Syntec' },
    { name: 'Abonnements Ximi - NHS', vendor: 'Xelya', category: 'saas', quantity: 1, unitCost: '5800.00', amount: '5800.00', billingCycle: 'monthly', contractStart: '2025-11-01', contractEnd: null, billingEntity: 'NHS', notes: 'Basé sur relevé 10/2024 avec application Syntec' },
    { name: 'Abonnements Ximi - NHS PACA', vendor: 'Xelya', category: 'saas', quantity: 1, unitCost: '825.00', amount: '825.00', billingCycle: 'monthly', contractStart: '2025-11-01', contractEnd: null, billingEntity: 'NHS PACA', notes: 'Basé sur relevé 10/2024 avec application Syntec' },
    { name: 'Sauvegarde All-ONELA et fichiers Ximi', vendor: 'Xelya', category: 'saas', quantity: 1, unitCost: '203.00', amount: '203.00', billingCycle: 'monthly', contractStart: '2025-11-01', contractEnd: null, billingEntity: ONS, notes: null },
    { name: 'Remise commerciale Xelya', vendor: 'Xelya', category: 'other', quantity: 1, unitCost: null, amount: '-31254.92', billingCycle: 'one_time', contractStart: '2023-12-01', contractEnd: '2023-12-31', billingEntity: null, notes: "Estimation — Période 1er nov 2022 – 31 oct 2023 : 0 €" },
    { name: 'Learning Management Système AAP', vendor: 'Fvrther', category: 'saas', quantity: 1, unitCost: '3000.00', amount: '3000.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: '3 000 € / mois — contrat terminant 31/12/2024' },
    { name: 'ClicRdV - Abonnement Sophie Schr.', vendor: 'Solocal', category: 'saas', quantity: 1, unitCost: '29.00', amount: '29.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Licences Eolia (recruteurs + portail)', vendor: 'Eolia Software', category: 'saas', quantity: 1, unitCost: '1147.10', amount: '1147.10', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: '4 logins recruteurs / 100 logins recruteurs light / portail' },
    { name: 'Augmentation Eolia prévisionnelle +4%', vendor: 'Eolia Software', category: 'saas', quantity: 1, unitCost: '45.88', amount: '45.88', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: 'Augmentation estimée à partir de 2025' },
    { name: 'Wedoxa Salariés', vendor: 'Wesatis', category: 'saas', quantity: 67, unitCost: '50.00', amount: '3350.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: '2025-12-31', billingEntity: CD, notes: '1 enquête annuelle — 50 €/agence' },
    { name: 'Wedoxa Salariés - Prestation', vendor: 'Wesatis', category: 'support', quantity: 2, unitCost: '800.00', amount: '1600.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: '2025-12-31', billingEntity: CD, notes: null },
    { name: 'WhistleLink - Alerte Saas', vendor: 'WhistleLink', category: 'saas', quantity: 1, unitCost: '1188.00', amount: '1188.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: 'Coût par mois : 99 €' },
    { name: 'Mailstream on Demande - Mise sous pli', vendor: 'Pitney Bowes', category: 'other', quantity: 1, unitCost: '15605.75', amount: '15605.75', billingCycle: 'quarterly', contractStart: '2022-04-01', contractEnd: null, billingEntity: CD, notes: 'OID-06348306 — 16 trimestres à partir de 03/2022' },
    { name: 'Wedoxa Clients (67 agences)', vendor: 'Wesatis', category: 'saas', quantity: 67, unitCost: '147.00', amount: '9849.00', billingCycle: 'quarterly', contractStart: '2025-01-01', contractEnd: '2025-09-30', billingEntity: CD, notes: 'Coût par mois : 49 €/agence' },
    { name: 'Wedoxa Clients', vendor: 'Wesatis', category: 'saas', quantity: 1, unitCost: '4900.00', amount: '4900.00', billingCycle: 'quarterly', contractStart: '2025-10-01', contractEnd: null, billingEntity: CD, notes: 'Coût par mois : 49 €/agence' },
    { name: 'Frais mise en service onela.mssante.fr', vendor: 'Wraptor', category: 'saas', quantity: 1, unitCost: '1500.00', amount: '1500.00', billingCycle: 'one_time', contractStart: '2025-09-22', contractEnd: '2025-12-31', billingEntity: CD, notes: null },
    { name: 'Abonnement annuel MSSANTE onela.mssante.fr', vendor: 'Wraptor', category: 'saas', quantity: 1, unitCost: '7167.00', amount: '7167.00', billingCycle: 'annual', contractStart: '2025-09-22', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Emailing Brevo (ex-Sendinblue)', vendor: 'Brevo', category: 'saas', quantity: 1, unitCost: '25.00', amount: '25.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: 'CB Fabienne DUBOIS' },
    { name: 'Friendly Captcha - Captcha site internet', vendor: 'FriendlyCaptcha', category: 'saas', quantity: 1, unitCost: '200.00', amount: '200.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Filmora - Édition vidéo', vendor: 'Wondershare', category: 'saas', quantity: 1, unitCost: '44.99', amount: '44.99', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: 'Période 20/03/a – 20/03/a+1 — compte prélevé : 4556***6389' },
    { name: 'DragnSurvey - Sondage Saas', vendor: 'DragnSurvey', category: 'saas', quantity: 1, unitCost: '432.00', amount: '432.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: 'CB Fabienne DUBOIS' },
    { name: 'Vimeo - Diffusion vidéo', vendor: 'Vimeo', category: 'saas', quantity: 1, unitCost: '96.00', amount: '96.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: 'CB Fabienne DUBOIS — Période 03/a–03/a+1' },
    { name: 'Google My Business - Abonnement', vendor: 'Google', category: 'saas', quantity: 1, unitCost: '25.00', amount: '25.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Canva Pro - Édition graphique', vendor: 'Canva', category: 'saas', quantity: 1, unitCost: '110.00', amount: '110.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Yoast Premium - SEO site internet', vendor: 'Yoast', category: 'saas', quantity: 1, unitCost: '99.00', amount: '99.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Matomo - Statistiques site internet', vendor: 'Systonic', category: 'saas', quantity: 1, unitCost: '200.00', amount: '200.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Nom de domaine onela.fr', vendor: 'Systonic', category: 'saas', quantity: 1, unitCost: '35.00', amount: '35.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Certificat SSL onela.com', vendor: 'Systonic', category: 'saas', quantity: 1, unitCost: '527.50', amount: '527.50', billingCycle: 'annual', contractStart: '2025-04-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Certificat SSL onela.fr', vendor: 'Systonic', category: 'saas', quantity: 1, unitCost: '527.50', amount: '527.50', billingCycle: 'annual', contractStart: '2025-06-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Logiciel de cartographie Smappen', vendor: 'Smappen', category: 'saas', quantity: 1, unitCost: '199.00', amount: '199.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: 'CB Fabienne DUBOIS' },
    { name: 'Certificat onela.fr (Sectigo)', vendor: 'Sectigo', category: 'saas', quantity: 1, unitCost: '91.00', amount: '91.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: '2025-06-01', billingEntity: CD, notes: '1 an — payé par CB' },
    { name: 'Maintenance site onela.com', vendor: 'Kanbios', category: 'support', quantity: 1, unitCost: '2400.00', amount: '2400.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Kyriba - FTP', vendor: 'Kyriba', category: 'saas', quantity: 1, unitCost: '188.00', amount: '188.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Kyriba - Cash and Liquidity Management', vendor: 'Kyriba', category: 'saas', quantity: 2, unitCost: '3627.37', amount: '7254.74', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: '3 627,37 € / semestre' },
    { name: 'Kyriba - Paiement Management', vendor: 'Kyriba', category: 'saas', quantity: 2, unitCost: '336.00', amount: '672.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: '336 € / semestre' },
    { name: 'Kyriba - Signature électronique', vendor: 'Kyriba', category: 'saas', quantity: 2, unitCost: '15.69', amount: '31.38', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Kyriba - Financial Transactions', vendor: 'Kyriba', category: 'saas', quantity: 1, unitCost: '441.76', amount: '441.76', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Kyriba - Fraud Management (x3 utilisateurs)', vendor: 'Kyriba', category: 'saas', quantity: 3, unitCost: '853.62', amount: '2560.86', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: '284,54 € / 4 mois' },
    { name: 'Sage - DSU Invoke (Liasse fiscale)', vendor: 'Axel Gestion', category: 'saas', quantity: 1, unitCost: '6600.00', amount: '6600.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: '3 utilisateurs' },
    { name: 'Sage - DSU BI Reporting - Connecteur comptabilité + 1 util.', vendor: 'Axel Gestion', category: 'saas', quantity: 1, unitCost: '1264.00', amount: '1264.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Sage - DSU BI Reporting - 2 utilisateurs', vendor: 'Axel Gestion', category: 'saas', quantity: 2, unitCost: '716.00', amount: '1432.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Sage - DSU FRP 1000 Cloud Comptabilité', vendor: 'Axel Gestion', category: 'saas', quantity: 1, unitCost: '16060.00', amount: '16060.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Sage - DSU FRP 1000 Cloud Immobilisations', vendor: 'Axel Gestion', category: 'saas', quantity: 1, unitCost: '1224.00', amount: '1224.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Augmentation Sage prévisionnelle +3% (2025)', vendor: 'Axel Gestion', category: 'saas', quantity: 1, unitCost: '775.92', amount: '775.92', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Augmentation Sage prévisionnelle +3% (2026)', vendor: 'Axel Gestion', category: 'saas', quantity: 1, unitCost: '799.20', amount: '799.20', billingCycle: 'annual', contractStart: '2025-12-31', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Sage - Runtime SQL Server', vendor: 'Axel Gestion', category: 'saas', quantity: 1, unitCost: '707.00', amount: '707.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Maintenance machine CESU', vendor: 'BH Technologies', category: 'support', quantity: 1, unitCost: '470.60', amount: '470.60', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'BALM', notes: null },
    { name: 'GoAnywhere MFT - Licences Workflows Restricted', vendor: 'BlueFinch ESBD', category: 'license', quantity: 1, unitCost: '14400.00', amount: '14400.00', billingCycle: 'one_time', contractStart: '2024-12-01', contractEnd: '2027-11-30', billingEntity: CD, notes: 'Immobilisation sur 3 ans' },
    { name: 'GoAnywhere MFT - Maintenance annuelle', vendor: 'BlueFinch ESBD', category: 'support', quantity: 1, unitCost: '2880.00', amount: '2880.00', billingCycle: 'annual', contractStart: '2024-10-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'GoAnywhere MFT - Augmentation maintenance 2026', vendor: 'BlueFinch ESBD', category: 'support', quantity: 1, unitCost: '144.00', amount: '144.00', billingCycle: 'annual', contractStart: '2025-10-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Consommation Ximi - ONS', vendor: 'Xelya', category: 'other', quantity: 1, unitCost: null, amount: '0.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: ONS, notes: 'Basé sur relevé 10/2024' },
    { name: 'Consommation Ximi - BALM - Téléphonie', vendor: 'Xelya', category: 'other', quantity: 1, unitCost: '75000.00', amount: '75000.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: '2025-10-15', billingEntity: 'BALM', notes: 'Basé sur relevé 10/2024' },
    { name: 'Consommation Ximi - BALM - Mail', vendor: 'Xelya', category: 'other', quantity: 1, unitCost: '76.00', amount: '76.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'BALM', notes: 'Basé sur relevé 10/2024' },
    { name: 'Consommation Ximi - BALM - TG', vendor: 'Xelya', category: 'other', quantity: 1, unitCost: '90000.00', amount: '90000.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'BALM', notes: 'Basé sur relevé 10/2024' },
    { name: 'Consommation Ximi - BALM - WF', vendor: 'Xelya', category: 'other', quantity: 1, unitCost: '5000.00', amount: '5000.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'BALM', notes: 'Basé sur relevé 10/2024' },
    { name: 'Consommation Ximi - NHS - Téléphonie', vendor: 'Xelya', category: 'other', quantity: 1, unitCost: '15000.00', amount: '15000.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: '2025-10-15', billingEntity: 'NHS', notes: 'Basé sur relevé 10/2024' },
    { name: 'Consommation Ximi - NHS - TG', vendor: 'Xelya', category: 'other', quantity: 1, unitCost: '18000.00', amount: '18000.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'NHS', notes: 'Basé sur relevé 10/2024' },
    { name: 'Consommation Ximi - NHS - WF', vendor: 'Xelya', category: 'other', quantity: 1, unitCost: '600.00', amount: '600.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'NHS', notes: 'Basé sur relevé 10/2024' },
    { name: 'Consommation Ximi - NHS PACA - Téléphonie', vendor: 'Xelya', category: 'other', quantity: 1, unitCost: '1713.00', amount: '1713.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: '2025-10-15', billingEntity: 'NHS PACA', notes: 'Basé sur relevé 10/2024' },
    { name: 'Consommation Ximi - NHS PACA - TG', vendor: 'Xelya', category: 'other', quantity: 1, unitCost: '3310.00', amount: '3310.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'NHS PACA', notes: 'Basé sur relevé 10/2024' },
    { name: 'Télégestion Savigny-sur-orge', vendor: 'Arche MC2', category: 'other', quantity: 1, unitCost: '90.00', amount: '90.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'BALM', notes: null },
    { name: 'Télégestion Chilly-Mazarin', vendor: 'Arche MC2', category: 'other', quantity: 1, unitCost: '130.00', amount: '130.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'NHS', notes: 'Facture au nom de NHS - Boulogne' },
    { name: 'Affranchissement MailStream On Demand', vendor: 'Pitney Bowes', category: 'other', quantity: 1, unitCost: '115000.00', amount: '115000.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Photocopieurs Konica Minolta - Paie Siège', vendor: 'Koesio', category: 'hardware', quantity: 1, unitCost: '900.00', amount: '900.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'BALM', notes: 'Ref : A7PU027021479 — facturation BALM' },
    { name: 'Photocopieurs Konica Minolta - Consommation agences', vendor: 'Koesio', category: 'hardware', quantity: 1, unitCost: '10000.00', amount: '10000.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'BALM', notes: 'Estimation pour les agences — facturation BALM' },
    { name: 'Photocopieurs Konica Minolta - Consommation NHS', vendor: 'Koesio', category: 'hardware', quantity: 1, unitCost: '300.00', amount: '300.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'NHS', notes: 'Estimation pour les agences — facturation NHS' },
    { name: 'Photocopieurs Ricoh - Consommation Siège', vendor: 'Ricoh', category: 'hardware', quantity: 1, unitCost: '450.00', amount: '450.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: 'Estimation consommation Siège' },
    { name: 'Photocopieurs Ricoh - Consommation BALM', vendor: 'Ricoh', category: 'hardware', quantity: 1, unitCost: '35000.00', amount: '35000.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'BALM', notes: 'Estimation consommation' },
    { name: 'Photocopieurs Ricoh - Consommation NHS', vendor: 'Ricoh', category: 'hardware', quantity: 1, unitCost: '5600.00', amount: '5600.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'NHS', notes: 'Estimation consommation' },
    { name: 'Photocopieurs Ricoh - Consommation NHS PACA', vendor: 'Ricoh', category: 'hardware', quantity: 1, unitCost: '1500.00', amount: '1500.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'NHS PACA', notes: 'Estimation consommation' },
    { name: "Envoi de SMS par SMSBox", vendor: "MIL'NR3", category: 'other', quantity: 1, unitCost: '2900.00', amount: '2900.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'BALM', notes: null },
    { name: 'Souris + Casques + Téléphones mobiles - Siège', vendor: 'Econocom', category: 'hardware', quantity: 10, unitCost: '285.25', amount: '2852.50', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Fournitures diverses - Siège', vendor: 'Econocom', category: 'hardware', quantity: 1, unitCost: '3000.00', amount: '3000.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Souris + Casques - BALM', vendor: 'Econocom', category: 'hardware', quantity: 116, unitCost: '55.25', amount: '6409.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'BALM', notes: null },
    { name: 'Souris + Casques - NHS', vendor: 'Econocom', category: 'hardware', quantity: 22, unitCost: '55.25', amount: '1215.50', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'NHS', notes: null },
    { name: 'Souris + Casques - NHS PACA', vendor: 'Econocom', category: 'hardware', quantity: 4, unitCost: '55.25', amount: '221.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'NHS PACA', notes: null },
    { name: 'Téléphones mobiles - BALM', vendor: 'Econocom', category: 'hardware', quantity: 27, unitCost: '230.00', amount: '6210.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'BALM', notes: 'Non immobilisé — durée de vie limitée' },
    { name: 'Téléphones mobiles - NHS', vendor: 'Econocom', category: 'hardware', quantity: 5, unitCost: '230.00', amount: '1150.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'NHS', notes: 'Non immobilisé — durée de vie limitée' },
    { name: 'Téléphones mobiles - NHS PACA', vendor: 'Econocom', category: 'hardware', quantity: 1, unitCost: '230.00', amount: '230.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'NHS PACA', notes: 'Non immobilisé — durée de vie limitée' },
    { name: 'Réalisation de master pour PC', vendor: 'Econocom', category: 'hardware', quantity: 2, unitCost: '2700.00', amount: '5400.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Hébergement Active Directory ONELA', vendor: 'Koesio', category: 'cloud', quantity: 1, unitCost: '320.72', amount: '320.72', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Hébergement Active Directory ONELA (2ème)', vendor: 'DELETEC', category: 'cloud', quantity: 1, unitCost: '689.00', amount: '689.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Reprise ancien matériel', vendor: 'ATF Gaia', category: 'hardware', quantity: 1, unitCost: '4200.00', amount: '4200.00', billingCycle: 'annual', contractStart: '2025-03-01', contractEnd: null, billingEntity: CD, notes: 'Estimation : 15 sites avec reprise de matériel' },
    { name: 'DPO (Antoine Bourbon + assistant)', vendor: 'Atos Eviden', category: 'support', quantity: 10, unitCost: '1850.00', amount: '18500.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: 'Estimation : 10 jours par profil' },
    { name: 'Datawarehouse - Hébergement VM1', vendor: 'Koesio', category: 'cloud', quantity: 1, unitCost: '594.68', amount: '594.68', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: 'Facturé réel VM1 : 762,46 €/mois' },
    { name: 'Datawarehouse - Avenant RAM + disque VM1', vendor: 'Koesio', category: 'cloud', quantity: 1, unitCost: '161.16', amount: '161.16', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: '156,16 € + 5 €/mois' },
    { name: 'Datawarehouse - Connexion SSL CIS-Valley – IDIGAO', vendor: 'Koesio', category: 'cloud', quantity: 1, unitCost: '4.00', amount: '4.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Datawarehouse - Hébergement VM2', vendor: 'Koesio', category: 'cloud', quantity: 1, unitCost: '174.42', amount: '174.42', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: 'Facturé réel VM2 : 146,16 €/mois' },
    { name: 'Datawarehouse - Avenant 4 Go RAM VM2', vendor: 'Koesio', category: 'cloud', quantity: 1, unitCost: '19.52', amount: '19.52', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Datawarehouse - Location licences SQL Server Std 2019 (8 users)', vendor: 'Koesio', category: 'license', quantity: 1, unitCost: '135.52', amount: '135.52', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'GoAnywhere MFT - Hébergement serveur', vendor: 'Koesio', category: 'cloud', quantity: 1, unitCost: '297.57', amount: '297.57', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Datawarehouse - Évolution du périmètre', vendor: 'Koesio', category: 'cloud', quantity: 1, unitCost: '80.00', amount: '80.00', billingCycle: 'monthly', contractStart: '2025-03-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Hébergement site internet', vendor: 'Systonic', category: 'cloud', quantity: 1, unitCost: '2954.20', amount: '2954.20', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Maintenance évolutive site onela.com', vendor: 'Kanbios', category: 'support', quantity: 1, unitCost: '5000.00', amount: '5000.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'WeChooz - Consultation électronique CSE', vendor: 'Techeunomie', category: 'support', quantity: 5, unitCost: '590.00', amount: '2950.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'WeChooz - Consultation CSE (coût supplémentaire)', vendor: 'Techeunomie', category: 'support', quantity: 1, unitCost: '14448.00', amount: '14448.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: '2025-12-31', billingEntity: CD, notes: 'À maintenir ?' },
    { name: 'Prestations diverses Kyriba', vendor: 'BDO', category: 'support', quantity: 1, unitCost: '10000.00', amount: '10000.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Sage - Service Telemaintenance', vendor: 'Axel Gestion', category: 'support', quantity: 1, unitCost: '300.00', amount: '300.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Sage - Gestion des interfaces', vendor: 'Axel Gestion', category: 'support', quantity: 1, unitCost: '1987.00', amount: '1987.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Sage - Génération ordre de paiement', vendor: 'Axel Gestion', category: 'support', quantity: 1, unitCost: '85.00', amount: '85.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Sage - Hébergement des applications', vendor: 'Axel Gestion', category: 'cloud', quantity: 1, unitCost: '5404.00', amount: '5404.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Sage - Certificat pour sFTP', vendor: 'Axel Gestion', category: 'saas', quantity: 1, unitCost: '360.00', amount: '360.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Sage - Extension disque supplémentaire 2To', vendor: 'Axel Gestion', category: 'cloud', quantity: 1, unitCost: '4220.00', amount: '4220.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Prestations diverses SAGE', vendor: 'Axel Gestion', category: 'support', quantity: 1, unitCost: '4000.00', amount: '4000.00', billingCycle: 'annual', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Yooz Business Edition 500 - Vendor Invoice Process', vendor: 'Yooz', category: 'saas', quantity: 1, unitCost: '429.00', amount: '429.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Yooz Add-On @Capture+', vendor: 'Yooz', category: 'saas', quantity: 1, unitCost: '139.00', amount: '139.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Yooz Add-On Dynamic Workflow', vendor: 'Yooz', category: 'saas', quantity: 1, unitCost: '139.00', amount: '139.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Yooz Add-On YoozProtect+', vendor: 'Yooz', category: 'saas', quantity: 1, unitCost: '125.00', amount: '125.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Yooz Add-On Récupération Historique', vendor: 'Yooz', category: 'saas', quantity: 1, unitCost: '350.00', amount: '350.00', billingCycle: 'monthly', contractStart: '2024-11-01', contractEnd: '2025-11-30', billingEntity: CD, notes: 'Montant sur 12 mois seulement' },
    { name: 'Jours VBA', vendor: '?', category: 'support', quantity: 5, unitCost: '400.00', amount: '2000.00', billingCycle: 'annual', contractStart: '2025-11-01', contractEnd: null, billingEntity: CD, notes: null },
    { name: 'Maintenance DWS', vendor: 'IDIGAO', category: 'support', quantity: 1, unitCost: '2500.00', amount: '2500.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: null },
    // ── SFR (lignes télécom mobiles) ─────────────────────────────────────────────
    { name: '10 lignes mobiles SFR', vendor: 'SFR', category: 'telecom', quantity: 1, unitCost: '116.80', amount: '116.80', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'BALM', notes: 'Fin engagement : fin mars/fin avril/fin juillet 2023' },
    { name: '116 lignes mobiles SFR', vendor: 'SFR', category: 'telecom', quantity: 1, unitCost: '1695.60', amount: '1695.60', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'BALM', notes: null },
    { name: 'Consommation hors forfait lignes mobiles SFR', vendor: 'SFR', category: 'telecom', quantity: 1, unitCost: '40.00', amount: '40.00', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'BALM', notes: null },
    // ── Bouygues Telecom (accès internet agences) ─────────────────────────────────
    { name: 'Accès internet agences Bouygues (8.14019.10)', vendor: 'Bouygues Telecom', category: 'telecom', quantity: 1, unitCost: '1302.46', amount: '1302.46', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: 'Compte BTE sous entité CDM : 8.14019.10' },
    { name: 'Accès internet agences Bouygues (8.14019.14)', vendor: 'Bouygues Telecom', category: 'telecom', quantity: 1, unitCost: '805.38', amount: '805.38', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: CD, notes: 'Compte BTE sous entité CDM : 8.14019.14' },
    { name: 'Accès internet agences Bouygues (8.14019.11)', vendor: 'Bouygues Telecom', category: 'telecom', quantity: 1, unitCost: '3679.93', amount: '3679.93', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'BALM', notes: 'Compte BTE sous entité CDM : 8.14019.11' },
    { name: 'Accès internet agences Bouygues (8.14081.10)', vendor: 'Bouygues Telecom', category: 'telecom', quantity: 1, unitCost: '92.78', amount: '92.78', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'BALM', notes: 'Compte BTE sous entité BALM : 8.14081,10 — Doit disparaitre' },
    { name: 'Accès internet agences Bouygues (8.14019.12)', vendor: 'Bouygues Telecom', category: 'telecom', quantity: 1, unitCost: '628.61', amount: '628.61', billingCycle: 'monthly', contractStart: '2025-01-01', contractEnd: null, billingEntity: 'NHS', notes: 'Compte BTE sous entité CDM : 8.14019.12' },
  ] as const

  await db.delete(budgetItems)

  let ok = 0
  const errors: string[] = []

  for (const item of ITEMS) {
    try {
      await db.insert(budgetItems).values({
        id: randomUUID(),
        name: item.name,
        vendor: item.vendor ?? null,
        category: item.category as typeof budgetItems.$inferInsert['category'],
        quantity: item.quantity,
        unitCost: item.unitCost ?? null,
        amount: item.amount,
        currency: 'EUR',
        billingCycle: item.billingCycle as typeof budgetItems.$inferInsert['billingCycle'],
        contractStart: item.contractStart ?? null,
        contractEnd: item.contractEnd ?? null,
        autoRenewal: 0,
        renewalAlertDays: 60,
        status: computeStatus(item.contractEnd ?? null),
        billingEntity: (item.billingEntity ?? null) as typeof budgetItems.$inferInsert['billingEntity'],
        notes: item.notes ?? null,
        createdAt: now,
        updatedAt: now,
      })
      ok++
    } catch (e) {
      errors.push(`${item.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return c.json({ inserted: ok, total: ITEMS.length, errors })
})
// ── Fin seed temporaire ────────────────────────────────────────────────────────

budgetRouter.use('*', authMiddleware, loadUserRole)

// ── Stats / récap ──────────────────────────────────────────────────────────────
budgetRouter.get('/stats', requirePermission('budget:read'), async (c) => {
  const db = getDb()
  const today = new Date().toISOString().slice(0, 10)
  const in30 = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)
  const in90 = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)

  const active = await db.select().from(budgetItems).where(eq(budgetItems.status, 'active'))
  const expiringSoon = await db.select().from(budgetItems)
    .where(and(
      or(eq(budgetItems.status, 'active'), eq(budgetItems.status, 'expiring_soon')),
      gte(budgetItems.contractEnd, today),
      lte(budgetItems.contractEnd, in90)
    ))
  const expired = await db.select().from(budgetItems).where(eq(budgetItems.status, 'expired'))

  // Calcul dépenses annualisées
  const toAnnual = (item: typeof active[number]) => {
    const amt = Number(item.amount)
    switch (item.billingCycle) {
      case 'monthly': return amt * 12
      case 'quarterly': return amt * 4
      case 'annual': return amt
      case 'one_time': return amt
    }
  }

  const allItems = await db.select().from(budgetItems)
  const activeItems = allItems.filter(i => i.status === 'active' || i.status === 'expiring_soon')
  const totalAnnual = activeItems.reduce((s, i) => s + toAnnual(i), 0)
  const totalMonthly = totalAnnual / 12

  // Par catégorie
  const byCategory: Record<string, number> = {}
  for (const item of activeItems) {
    const cat = item.category ?? 'other'
    byCategory[cat] = (byCategory[cat] ?? 0) + toAnnual(item)
  }

  // Contrats expirant dans 30j
  const expiring30 = expiringSoon.filter(i => i.contractEnd && i.contractEnd <= in30)

  return c.json({
    totalAnnual: Math.round(totalAnnual * 100) / 100,
    totalMonthly: Math.round(totalMonthly * 100) / 100,
    activeCount: active.length,
    expiringSoonCount: expiringSoon.length,
    expiring30Count: expiring30.length,
    expiredCount: expired.length,
    byCategory,
  })
})

// ── Liste des lignes budget ───────────────────────────────────────────────────
budgetRouter.get('/items', requirePermission('budget:read'), async (c) => {
  const db = getDb()
  const category = c.req.query('category') as typeof budgetItems.$inferSelect['category'] | undefined
  const status = c.req.query('status') as typeof budgetItems.$inferSelect['status'] | undefined
  const entity = c.req.query('entity') as typeof budgetItems.$inferSelect['billingEntity'] | undefined
  const search = c.req.query('q')

  const filters = []
  if (category) filters.push(eq(budgetItems.category, category))
  if (status) filters.push(eq(budgetItems.status, status))
  if (entity) filters.push(eq(budgetItems.billingEntity, entity))
  if (search) filters.push(or(
    like(budgetItems.name, `%${search}%`),
    like(budgetItems.vendor, `%${search}%`)
  ))

  const rows = await db.select().from(budgetItems)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(budgetItems.contractEnd))

  return c.json({ items: rows })
})

// ── Créer une ligne budget ────────────────────────────────────────────────────
budgetRouter.post('/items', requirePermission('budget:write'), async (c) => {
  const db = getDb()
  const body = await c.req.json()
  const id = randomUUID()
  const now = new Date()

  const status = computeStatus(body.contractEnd, body.status)
  const { quantity, unitCost, amount } = computeAmounts(body)

  await db.insert(budgetItems).values({
    id,
    name: body.name,
    vendor: body.vendor ?? null,
    category: body.category ?? 'other',
    quantity,
    unitCost,
    amount,
    currency: body.currency ?? 'EUR',
    billingCycle: body.billingCycle ?? 'annual',
    contractStart: body.contractStart ?? null,
    contractEnd: body.contractEnd ?? null,
    autoRenewal: body.autoRenewal ? 1 : 0,
    renewalAlertDays: body.renewalAlertDays ?? 60,
    status,
    billingEntity: body.billingEntity ?? null,
    notes: body.notes ?? null,
    createdAt: now,
    updatedAt: now,
  })

  const [row] = await db.select().from(budgetItems).where(eq(budgetItems.id, id))
  return c.json(row, 201)
})

// ── Modifier une ligne budget ─────────────────────────────────────────────────
budgetRouter.put('/items/:id', requirePermission('budget:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const body = await c.req.json()

  const status = computeStatus(body.contractEnd, body.status)
  const { quantity, unitCost, amount } = computeAmounts(body)

  await db.update(budgetItems).set({
    name: body.name,
    vendor: body.vendor ?? null,
    category: body.category ?? 'other',
    quantity,
    unitCost,
    amount,
    currency: body.currency ?? 'EUR',
    billingCycle: body.billingCycle ?? 'annual',
    contractStart: body.contractStart ?? null,
    contractEnd: body.contractEnd ?? null,
    autoRenewal: body.autoRenewal ? 1 : 0,
    renewalAlertDays: body.renewalAlertDays ?? 60,
    status,
    billingEntity: body.billingEntity ?? null,
    notes: body.notes ?? null,
    updatedAt: new Date(),
  }).where(eq(budgetItems.id, id))

  const [row] = await db.select().from(budgetItems).where(eq(budgetItems.id, id))
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json(row)
})

// ── Supprimer une ligne budget ────────────────────────────────────────────────
budgetRouter.delete('/items/:id', requirePermission('budget:write'), async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  await db.delete(budgetItems).where(eq(budgetItems.id, id))
  return c.json({ deleted: true })
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function computeAmounts(body: Record<string, unknown>) {
  const quantity = Number(body.quantity ?? 1) || 1
  const unitCost = body.unitCost !== null && body.unitCost !== '' && body.unitCost !== undefined
    ? Number(body.unitCost)
    : null
  const amount = unitCost !== null
    ? String((quantity * unitCost).toFixed(2))
    : String(Number(body.amount ?? 0).toFixed(2))
  return { quantity, unitCost: unitCost !== null ? String(unitCost.toFixed(2)) : null, amount }
}

function computeStatus(
  contractEnd: string | null | undefined,
  explicitStatus: string | null | undefined
): 'active' | 'expiring_soon' | 'expired' | 'cancelled' {
  if (explicitStatus === 'cancelled') return 'cancelled'
  if (!contractEnd) return 'active'
  const today = new Date().toISOString().slice(0, 10)
  const in90 = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)
  if (contractEnd < today) return 'expired'
  if (contractEnd <= in90) return 'expiring_soon'
  return 'active'
}
