// Script de plateforme Intune (tenant ONELA) qui pose sur le poste un raccourci
// « Messagerie ONELA » : Chrome dans un profil dédié, sur la connexion Google avec
// l'identifiant pré-rempli, puis Gmail. Généré par région : la table UPN ONELA →
// compte Google est remplie depuis les groupes d'agence + la table `migrations`.
//
// Les UPN ONELA ne suivent pas tous le format prenom.nom (ex. pnom@onela.com),
// d'où une table explicite plutôt qu'une déduction sur le poste.

export interface ChromeLoginEntry {
  onelaUpn: string
  onelaMail: string | null
  googleLogin: string
  displayName: string
  agencyCode: string
  // 'migré' = compte Google déjà créé par la DSI App ; 'prévu' = adresse calculée
  // avec la même règle que la migration (prenom.nom@mig.onela.com).
  source: 'migré' | 'prévu'
}

// Chaîne PowerShell entre apostrophes : on double les apostrophes internes.
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

// Commentaire PowerShell sur une ligne (pas de retour à la ligne injecté).
function psComment(s: string): string {
  return s.replace(/[\r\n]+/g, ' ')
}

export function buildIntuneChromeScript(region: string, entries: ChromeLoginEntry[], generatedAt: Date): string {
  const mapLines: string[] = []
  const seen = new Set<string>()
  const sorted = [...entries].sort((a, b) => a.agencyCode.localeCompare(b.agencyCode) || a.displayName.localeCompare(b.displayName, 'fr'))
  for (const e of sorted) {
    const keys = [e.onelaUpn, e.onelaMail ?? ''].map((k) => k.trim().toLowerCase()).filter((k) => k && !seen.has(k))
    if (keys.length === 0) continue
    mapLines.push(`  # ${psComment(`${e.agencyCode} · ${e.displayName} (${e.source})`)}`)
    for (const k of keys) {
      seen.add(k)
      mapLines.push(`  ${psQuote(k)} = ${psQuote(e.googleLogin.toLowerCase())}`)
    }
  }
  const migrated = entries.filter((e) => e.source === 'migré').length

  const lines = `<#
  Profil Chrome professionnel ONELA — région ${psComment(region)}
  Généré par la DSI App le ${generatedAt.toISOString()} : ${entries.length} utilisateurs (${migrated} migrés, ${entries.length - migrated} prévus).

  Crée, pour l'utilisateur connecté, un raccourci « Messagerie ONELA » sur le bureau
  et dans le menu Démarrer. Le raccourci lance Chrome dans un profil dédié
  (dossier « ONELA ») sur la page de connexion Google (identifiant pré-rempli), puis
  Gmail. Chrome crée le profil au premier lancement : plus de « Ajouter un profil Chrome ».

  Intune ONELA > Appareils > Scripts et corrections > Scripts de plateforme > Ajouter (Windows 10+) :
    - Exécuter ce script avec les informations d'identification de l'utilisateur connecté : OUI
    - Appliquer la vérification de la signature du script : NON
    - Exécuter le script dans un hôte PowerShell 64 bits : OUI
    - Affectation : groupe d'UTILISATEURS de la région (pas un groupe d'appareils)

  Aucun droit administrateur requis. Aucun mot de passe dans ce script.
  Journal : %LOCALAPPDATA%\\ONELA\\chrome-profil.log
#>

$ErrorActionPreference = 'Stop'

# ── Paramètres ────────────────────────────────────────────────────────────────
$ProfileDir   = 'ONELA'                 # dossier du profil dans "User Data" de Chrome
$ShortcutName = 'Messagerie ONELA'
$Continue     = 'https://mail.google.com/mail/'
$OpenNow      = $false                  # $true : ouvre Chrome dès l'exécution du script

# Ancienne adresse ONELA (UPN ou mail, minuscules) → compte Google.
$LoginMap = @{
${mapLines.join('\r\n')}
}

# ── Journal ───────────────────────────────────────────────────────────────────
$LogDir = Join-Path $env:LOCALAPPDATA 'ONELA'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir 'chrome-profil.log'
function Log([string]$m) { Add-Content -Path $LogFile -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $m) }

# UPN de l'utilisateur connecté : whoami (AD / Entra), sinon l'identité Office.
function Get-CurrentUpn {
  try {
    $u = (& whoami /upn 2>$null | Out-String).Trim().ToLower()
    if ($u -match '@') { return $u }
  } catch { }
  try {
    $u = (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Office\\16.0\\Common\\Identity' -Name ADUserName -ErrorAction Stop).ADUserName
    if ($u -match '@') { return $u.Trim().ToLower() }
  } catch { }
  return ''
}

try {
  # ── Chrome : installation machine ou utilisateur ───────────────────────────
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Google\\Chrome\\Application\\chrome.exe'),
    (Join-Path \${env:ProgramFiles(x86)} 'Google\\Chrome\\Application\\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\\Chrome\\Application\\chrome.exe')
  )
  $chrome = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $chrome) { Log 'ERREUR : Chrome introuvable.'; exit 1 }

  # ── URL de connexion (identifiant pré-rempli si connu) ──────────────────────
  $upn = Get-CurrentUpn
  $login = if ($upn -and $LoginMap.ContainsKey($upn)) { $LoginMap[$upn] } else { '' }

  $url = 'https://accounts.google.com/ServiceLogin?continue=' + [uri]::EscapeDataString($Continue)
  if ($login) { $url += '&Email=' + [uri]::EscapeDataString($login) }

  $arguments = '--profile-directory="' + $ProfileDir + '" --no-first-run "' + $url + '"'

  # ── Raccourcis bureau + menu Démarrer ──────────────────────────────────────
  $shell = New-Object -ComObject WScript.Shell
  foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    if (-not $folder) { continue }
    $lnk = $shell.CreateShortcut((Join-Path $folder ($ShortcutName + '.lnk')))
    $lnk.TargetPath       = $chrome
    $lnk.Arguments        = $arguments
    $lnk.WorkingDirectory = Split-Path $chrome
    $lnk.IconLocation     = $chrome + ',0'
    $lnk.Description      = 'Ouvre votre messagerie ONELA dans votre profil Chrome professionnel'
    $lnk.Save()
  }
  Log ("OK : raccourcis créés (upn='{0}', login='{1}', chrome='{2}')." -f $upn, $login, $chrome)

  if ($OpenNow) { Start-Process -FilePath $chrome -ArgumentList $arguments }
  exit 0
}
catch {
  Log ('ERREUR : ' + $_.Exception.Message)
  exit 1
}
`
  // BOM UTF-8 + CRLF : sans BOM, Windows PowerShell 5.1 lit le fichier en ANSI
  // (accents cassés dans le journal et la description du raccourci).
  return '﻿' + lines.replace(/\r?\n/g, '\r\n')
}
