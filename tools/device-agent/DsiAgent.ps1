#Requires -Version 5.1
<#
.SYNOPSIS
  Agent DSI - inventaire des PC ONELA avant leur bascule vers le tenant Ouihelp (lot 2).

.DESCRIPTION
  Un seul fichier, deux modes :
   - INSTALLATION : lancé depuis n'importe quel autre emplacement (script de plateforme
     Intune, script de démarrage GPO, à la main), il se copie dans C:\ProgramData\DSI,
     verrouille le dossier (SYSTEM + Administrateurs), crée la tâche planifiée
     « DSI Agent » (SYSTEM, au démarrage + toutes les 30 min) puis la lance.
     Ré-exécuter une version plus récente = mise à jour.
   - AGENT : lancé par la tâche planifiée depuis C:\ProgramData\DSI\DsiAgent.ps1, il
     collecte l'état du PC et l'envoie à la DSI App. Le serveur fixe la cadence réelle
     (nextCheckinMinutes) ; les passages intermédiaires sortent immédiatement.

  Hors bascule, LECTURE SEULE : l'agent ne modifie rien sur le poste. Il n'exécute jamais de
  commande reçue du serveur : les seules actions possibles sont les deux bascules codées
  ci-dessous, déclenchées uniquement si la DSI a programmé CE poste dans la DSI App :
   - « inplace » : bascule en place, Windows / applications / fichiers conservés, chaque profil
     Windows transféré au compte Ouihelp indiqué par la DSI App ;
   - « reset »   : réinstallation propre (Supprimer tout).

.PARAMETER Uninstall
  Supprime la tâche planifiée et C:\ProgramData\DSI.

.PARAMETER Force
  Mode agent : ignore la cadence et envoie un rapport tout de suite.
#>
param(
  [switch]$Uninstall,
  [switch]$Force
)

# ── Configuration (à renseigner avant déploiement) ───────────────────────────
$ApiUrl        = 'https://REMPLACER.azurewebsites.net'   # URL de l'API DSI App, sans /api
$EnrollmentKey = 'REMPLACER'                             # = DEVICE_AGENT_ENROLLMENT_KEY côté API
# ─────────────────────────────────────────────────────────────────────────────

$AgentVersion = '1.2.1'
$ErrorActionPreference = 'Stop'
$Root        = Join-Path $env:ProgramData 'DSI'
$InstalledPs = Join-Path $Root 'DsiAgent.ps1'
$TokenPath   = Join-Path $Root 'token'
$StatePath   = Join-Path $Root 'state.json'
$LogPath     = Join-Path $Root 'agent.log'
$TaskName    = 'DSI Agent'

function Write-Log([string]$Message) {
  try {
    if (-not (Test-Path $Root)) { return }
    if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -gt 1MB) {
      Move-Item $LogPath "$LogPath.1" -Force
    }
    Add-Content -Path $LogPath -Value ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $Message) -Encoding UTF8
  } catch { }
}

# Exécute un bloc ; en cas d'erreur, journalise et renvoie la valeur par défaut.
function Safe([string]$Label, [scriptblock]$Block, $Default = $null) {
  try { & $Block } catch { Write-Log "[$Label] $($_.Exception.Message)"; $Default }
}

function Test-IsSystemOrAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($id.User.Value -eq 'S-1-5-18') { return $true }
  return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ═════════════════════════════════════════════════════════════════════════════
# Installation / désinstallation
# ═════════════════════════════════════════════════════════════════════════════

function Install-Agent {
  if (-not (Test-IsSystemOrAdmin)) { throw 'Installation : droits administrateur ou SYSTEM requis' }
  if ($ApiUrl -like '*REMPLACER*' -or $EnrollmentKey -eq 'REMPLACER') { throw 'Configuration non renseignée ($ApiUrl / $EnrollmentKey)' }

  if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root -Force | Out-Null }
  # Dossier réservé à SYSTEM et aux Administrateurs : il contient la clé et le jeton
  & icacls.exe $Root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null

  Copy-Item -LiteralPath $PSCommandPath -Destination $InstalledPs -Force
  Write-Log "Installation v$AgentVersion depuis $PSCommandPath"

  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstalledPs`""
  $atStartup = New-ScheduledTaskTrigger -AtStartup
  $atStartup.Delay = 'PT5M'
  # Toutes les 2 min : réveil léger. L'inventaire complet reste espacé (nextCheckinAt, 4 h) ;
  # seul le sondage de bascule (Invoke-MigrationPoll) agit à chaque réveil → bascule réactive.
  $every30 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2)
  $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
  Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action -Trigger @($atStartup, $every30) `
    -Principal $principal -Settings $settings -Description 'Agent DSI ONELA - inventaire avant migration Ouihelp (lecture seule)' -Force | Out-Null

  # 1er rapport tout de suite, dans ce même processus : s'il échoue, le script Intune / GPO
  # sort en erreur avec la cause, visible à distance dans « État de l'appareil » d'Intune
  # (et Intune relance le script). Sans ça, un « Réussi » ne garantissait que l'installation.
  $script:Force = $true
  $err = Invoke-Checkin
  if ($err) { throw "Agent $AgentVersion installé mais 1er rapport en échec : $err" }
}

function Uninstall-Agent {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  if (Test-Path $Root) { Remove-Item $Root -Recurse -Force }
}

# ═════════════════════════════════════════════════════════════════════════════
# Collecte
# ═════════════════════════════════════════════════════════════════════════════

function Get-State {
  if (Test-Path $StatePath) {
    try { return Get-Content $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
  }
  return [pscustomobject]@{ nextCheckinAt = $null; profilesMeasuredAt = $null; profileSizes = $null }
}

function Save-State($State) {
  $State | ConvertTo-Json -Depth 4 | Set-Content -Path $StatePath -Encoding UTF8
}

function Get-DsregStatus {
  $map = @{}
  foreach ($line in (& (Get-DsregPath) /status 2>$null)) {
    if ($line -match '^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$' -and -not $map.ContainsKey($Matches[1])) {
      $map[$Matches[1]] = $Matches[2]
    }
  }
  $nz = { param($v) if ($v -and $v -ne '') { $v } else { $null } }
  [ordered]@{
    azureAdJoined   = ($map['AzureAdJoined'] -eq 'YES')
    domainJoined    = ($map['DomainJoined'] -eq 'YES')
    workplaceJoined = ($map['WorkplaceJoined'] -eq 'YES')
    deviceId        = & $nz $map['DeviceId']
    tenantId        = & $nz $map['TenantId']
    tenantName      = & $nz $map['TenantName']
  }
}

function Get-MdmState {
  $enrolled = $false; $upn = $null
  foreach ($k in (Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Enrollments' -ErrorAction SilentlyContinue)) {
    $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
    if ($p.ProviderID -eq 'MS DM Server' -and $p.EnrollmentState -eq 1) { $enrolled = $true; if ($p.UPN) { $upn = $p.UPN } }
  }
  # Inscription automatique poussée par GPO : reste écrite dans le registre après la sortie du domaine
  # Clé absente = cas normal (pas de GPO d'inscription) : pas de message d'erreur
  $mdmPolicy = Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\MDM' -ErrorAction SilentlyContinue
  $gpo = [bool]($mdmPolicy -and $mdmPolicy.AutoEnrollMDM -eq 1)
  [ordered]@{ enrolled = $enrolled; upn = $upn; gpoAutoEnroll = [bool]$gpo }
}

function Get-TpmState {
  $t = Safe 'tpm' { Get-Tpm }
  $present = [bool]($t -and $t.TpmPresent)
  $ready = [bool]($t -and $t.TpmReady)
  $version = $null
  $w = Safe 'tpmVersion' { Get-CimInstance -Namespace 'root\cimv2\Security\MicrosoftTpm' -ClassName Win32_Tpm }
  if ($w -and $w.SpecVersion) { $version = ($w.SpecVersion -split ',')[0].Trim() }
  [ordered]@{ present = $present; ready = $ready; version = $version }
}

function Get-WinreEnabled {
  # ReAgent.xml n'est pas localisé, contrairement à la sortie de reagentc
  $xmlPath = Join-Path $env:SystemRoot 'System32\Recovery\ReAgent.xml'
  if (Test-Path $xmlPath) {
    $x = Safe 'winre' { [xml](Get-Content $xmlPath -Raw) }
    if ($x -and $x.WindowsRE.InstallState) { return ($x.WindowsRE.InstallState.state -eq '1') }
  }
  return $null
}

function Get-BitlockerState {
  $v = Safe 'bitlocker' { Get-BitLockerVolume -MountPoint $env:SystemDrive }
  if (-not $v) { return [ordered]@{ protectionOn = $null; hasRecoveryPassword = $null } }
  [ordered]@{
    protectionOn        = ($v.ProtectionStatus -eq 'On')
    hasRecoveryPassword = [bool]($v.KeyProtector | Where-Object { $_.KeyProtectorType -eq 'RecoveryPassword' })
  }
}

# netsh mélange les encodages : libellés dans la page de code OEM de la console (« État »),
# SSID en UTF-8 brut (« Siège »). On lit les octets sans passer par la console et on
# décode chaque ligne en UTF-8 strict, à défaut en OEM.
function Invoke-NetshLines([string]$Arguments) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = Join-Path $env:SystemRoot 'System32\netsh.exe'
  $psi.Arguments = $Arguments
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $buffer = New-Object System.IO.MemoryStream
  $proc.StandardOutput.BaseStream.CopyTo($buffer)
  $proc.WaitForExit()
  $bytes = $buffer.ToArray()

  $utf8 = New-Object System.Text.UTF8Encoding($false, $true)   # lève une exception si invalide
  $oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
  $lines = @()
  $start = 0
  for ($i = 0; $i -le $bytes.Length; $i++) {
    if ($i -lt $bytes.Length -and $bytes[$i] -ne 10) { continue }
    $count = $i - $start
    if ($count -gt 0) {
      try { $line = $utf8.GetString($bytes, $start, $count) } catch { $line = $oem.GetString($bytes, $start, $count) }
      $lines += $line.TrimEnd("`r")
    }
    $start = $i + 1
  }
  return ,$lines
}

function Get-NetworkState {
  $ethernet = $false; $wifi = $false
  foreach ($a in (Safe 'netadapter' { Get-NetAdapter -Physical | Where-Object Status -eq 'Up' } @())) {
    if ($a.PhysicalMediaType -match '802\.11') { $wifi = $true }
    elseif ($a.PhysicalMediaType -match '802\.3') { $ethernet = $true }
  }
  $ssid = $null
  foreach ($line in (Safe 'netshInterfaces' { Invoke-NetshLines 'wlan show interfaces' } @())) {
    if ($line -match '^\s*SSID\s*:\s*(.+?)\s*$') { $ssid = $Matches[1]; break }
  }
  # Libellés localisés (« All User Profile » / « Profil Tous les utilisateurs ») : on prend la valeur après « : »
  $profiles = @()
  foreach ($line in (Safe 'netshProfiles' { Invoke-NetshLines 'wlan show profiles' } @())) {
    if ($line -match '(?i)profil.*?:\s*(.+?)\s*$') { $profiles += $Matches[1] }
  }
  [ordered]@{ ethernet = $ethernet; wifi = $wifi; ssid = $ssid; wifiProfiles = @($profiles | Select-Object -Unique) }
}

# Taille des fichiers présents localement (hors fichiers OneDrive « en ligne uniquement »),
# sans suivre les jonctions. Renvoie $null si le budget de temps est dépassé.
function Measure-LocalBytes([string]$Path, [datetime]$Deadline) {
  if (-not (Test-Path -LiteralPath $Path)) { return [long]0 }
  $total = [long]0
  $stack = New-Object System.Collections.Stack
  $stack.Push($Path)
  while ($stack.Count -gt 0) {
    if ((Get-Date) -gt $Deadline) { return $null }
    $dir = $stack.Pop()
    try { $items = (New-Object System.IO.DirectoryInfo $dir).GetFileSystemInfos() } catch { continue }
    foreach ($i in $items) {
      $attr = [int]$i.Attributes
      if ($i -is [System.IO.DirectoryInfo]) {
        if (($attr -band 0x400) -eq 0) { $stack.Push($i.FullName) }              # 0x400 = ReparsePoint
      } elseif (($attr -band 0x401000) -eq 0) {                                   # Offline | RecallOnDataAccess
        $total += $i.Length
      }
    }
  }
  return $total
}

# Dernière ouverture de session = dernier chargement du profil (Windows 10 1903+).
# Win32_UserProfile.LastUseTime est inutilisable : mis à jour par des tâches de fond.
function Get-ProfileLoadTime([string]$Sid) {
  $k = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$Sid" -ErrorAction Stop
  if ($null -eq $k.LocalProfileLoadTimeHigh -or $null -eq $k.LocalProfileLoadTimeLow) { return $null }
  # DWORD lus en Int32 signés OU en UInt32 selon la version de Windows : le masque sur
  # 32 bits donne la valeur non signée dans les deux cas (0xFFFFFFFF vaut -1 en PowerShell)
  $high = [int64]$k.LocalProfileLoadTimeHigh -band [int64]4294967295
  $low = [int64]$k.LocalProfileLoadTimeLow -band [int64]4294967295
  $fileTime = ($high -shl 32) -bor $low
  if ($fileTime -le 0) { return $null }
  return [DateTime]::FromFileTimeUtc($fileTime).ToString('o')
}

# UPN d'un compte AD, demandé au contrôleur de domaine (lecture LDAP avec le compte machine).
# Mis en cache dans state.json : le PC n'est pas toujours sur le réseau ONELA.
function Get-AdUpn([string]$Sid, $State) {
  if (-not $State.PSObject.Properties['adUpns']) { $State | Add-Member -NotePropertyName adUpns -NotePropertyValue ([pscustomobject]@{}) }
  $cached = $State.adUpns.PSObject.Properties[$Sid]
  if ($cached) { return $cached.Value }
  $searcher = [adsisearcher]"(objectSid=$Sid)"
  $searcher.ClientTimeout = [TimeSpan]::FromSeconds(5)
  [void]$searcher.PropertiesToLoad.Add('userPrincipalName')
  $hit = $searcher.FindOne()
  if (-not $hit -or -not $hit.Properties['userprincipalname']) { return $null }
  $upn = [string]$hit.Properties['userprincipalname'][0]
  $State.adUpns | Add-Member -NotePropertyName $Sid -NotePropertyValue $upn -Force
  return $upn
}

# UPN d'un compte Entra : son emplacement varie selon la version de Windows.
function Get-EntraUpn([string]$Sid) {
  $p = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\IdentityStore\Cache\$Sid\IdentityCache\$Sid" -ErrorAction SilentlyContinue
  if ($p -and $p.UserName) { return $p.UserName }
  foreach ($k in (Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\IdentityStore\LogonCache' -ErrorAction SilentlyContinue)) {
    $n = Get-ItemProperty (Join-Path $k.PSPath "Sid2Name\$Sid") -ErrorAction SilentlyContinue
    if ($n -and $n.IdentityName) { return $n.IdentityName }
  }
  return $null
}

function Get-Profiles($State) {
  $localSid = Safe 'localSid' { (Get-LocalUser | Select-Object -First 1).SID.AccountDomainSid.Value }
  $measure = $Force -or -not $State.profilesMeasuredAt -or ((Get-Date) - [datetime]$State.profilesMeasuredAt).TotalHours -ge 20
  $deadline = (Get-Date).AddMinutes(4)
  $sizes = @{}
  if (-not $measure -and $State.profileSizes) {
    foreach ($p in $State.profileSizes.PSObject.Properties) { $sizes[$p.Name] = $p.Value }
  }

  $result = @()
  $userProfiles = Safe 'profiles' { Get-CimInstance Win32_UserProfile | Where-Object { -not $_.Special -and $_.LocalPath -like "$env:SystemDrive\Users\*" } } @()
  foreach ($p in $userProfiles) {
    $sid = $p.SID
    $kind = 'unknown'; $account = $null; $upn = $null
    if ($sid -like 'S-1-12-1-*') {
      $kind = 'entra'
      $upn = Get-EntraUpn $sid
      $account = if ($upn) { $upn } else { Safe 'entraNt' { (New-Object Security.Principal.SecurityIdentifier $sid).Translate([Security.Principal.NTAccount]).Value } }
    } elseif ($sid -like 'S-1-5-21-*') {
      $kind = if ($localSid -and $sid.StartsWith("$localSid-")) { 'local' } else { 'ad' }
      $account = Safe 'ntName' { (New-Object Security.Principal.SecurityIdentifier $sid).Translate([Security.Principal.NTAccount]).Value }
      if ($kind -eq 'ad') { $upn = Safe 'adUpn' { Get-AdUpn $sid $State } }
    }
    if (-not $account) { $account = Split-Path $p.LocalPath -Leaf }

    if ($measure) {
      $bytes = [long]0
      $folders = @('Desktop', 'Documents', 'Downloads') | ForEach-Object { Join-Path $p.LocalPath $_ }
      $folders += @(Get-ChildItem -LiteralPath $p.LocalPath -Directory -Filter 'OneDrive*' -Force -ErrorAction SilentlyContinue | ForEach-Object FullName)
      foreach ($f in $folders) {
        $b = Measure-LocalBytes $f $deadline
        if ($null -eq $b) { $bytes = $null; break }
        $bytes += $b
      }
      $sizes[$sid] = if ($null -eq $bytes) { $null } else { [math]::Round($bytes / 1MB) }
    }

    $result += [ordered]@{
      sid         = $sid
      account     = $account
      upn         = $upn
      kind        = $kind
      lastUseTime = if ($p.LastUseTime) { $p.LastUseTime.ToUniversalTime().ToString('o') } else { $null }
      lastLogonTime = Safe 'loadTime' { Get-ProfileLoadTime $sid }
      loaded      = [bool]$p.Loaded
      localDataMb = $sizes[$sid]
    }
  }

  if ($measure) {
    $State.profilesMeasuredAt = (Get-Date).ToUniversalTime().ToString('o')
    $State.profileSizes = $sizes
  }
  return ,$result
}

# Désinstallation enregistrée pour une application : commande MSI ou QuietUninstallString.
# Renvoie $null quand aucune désinstallation silencieuse n'est possible (installeur interactif).
function Get-AppUninstall($Key) {
  $id = Split-Path $Key.PSPath -Leaf
  if ($Key.WindowsInstaller -eq 1 -and $id -match '^\{[0-9A-Fa-f-]{36}\}$') {
    return [ordered]@{ file = 'msiexec.exe'; arguments = "/x $id /qn /norestart" }
  }
  $quiet = [string]$Key.QuietUninstallString
  if (-not $quiet) { return $null }
  if ($quiet -match '^\s*"([^"]+)"\s*(.*)$') { return [ordered]@{ file = $Matches[1]; arguments = $Matches[2].Trim() } }
  if ($quiet -match '^\s*(\S+\.exe)\s*(.*)$') { return [ordered]@{ file = $Matches[1]; arguments = $Matches[2].Trim() } }
  return [ordered]@{ file = 'cmd.exe'; arguments = "/c $quiet" }
}

# Applications installées : clés Uninstall HKLM 32 et 64 bits, hors composants système,
# mises à jour et correctifs. Alimente le catalogue DSI (une décision par application pour
# tout le parc) ; la bascule en place ne désinstalle que ce que la DSI a décoché.
function Get-InstalledApps {
  $paths = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $byName = [ordered]@{}
  foreach ($k in (Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue)) {
    $name = [string]$k.DisplayName
    if (-not $name) { continue }
    if ($k.SystemComponent -eq 1 -or $k.ReleaseType -or $k.ParentKeyName) { continue }
    if ($name -match '^(KB\d{6,}|Security Update|Update for|Hotfix|Mise . jour)') { continue }
    if ($byName.Contains($name)) { continue }
    $byName[$name] = [ordered]@{
      name          = $name
      version       = [string]$k.DisplayVersion
      publisher     = [string]$k.Publisher
      uninstallable = [bool](Get-AppUninstall $k)
    }
  }
  return ,@($byName.Values)
}

# Désinstalle une application par son nom exact (tel que remonté dans le rapport), avec la
# commande enregistrée localement. L'agent n'exécute jamais une commande venue du serveur :
# le serveur ne transmet que des noms.
function Uninstall-AppByName([string]$Name) {
  $paths = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $key = Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue | Where-Object { [string]$_.DisplayName -eq $Name } | Select-Object -First 1
  if (-not $key) { return @{ ok = $true; message = 'déjà absente' } }
  $cmd = Get-AppUninstall $key
  if (-not $cmd) { return @{ ok = $false; message = 'pas de désinstallation silencieuse' } }
  try {
    $p = Start-Process -FilePath $cmd.file -ArgumentList $cmd.arguments -Wait -PassThru -WindowStyle Hidden
    # 1605 = déjà désinstallée, 1614 = produit inconnu, 1641 / 3010 = redémarrage demandé
    if ($p.ExitCode -in 0, 1605, 1614, 1641, 3010) { return @{ ok = $true; message = "code $($p.ExitCode)" } }
    return @{ ok = $false; message = "code $($p.ExitCode)" }
  } catch {
    return @{ ok = $false; message = $_.Exception.Message }
  }
}

function Get-Report($State) {
  $cs   = Get-CimInstance Win32_ComputerSystem
  $bios = Get-CimInstance Win32_BIOS
  $os   = Get-CimInstance Win32_OperatingSystem
  $cv   = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$env:SystemDrive'"
  $profiles = Get-Profiles $State

  [ordered]@{
    agentVersion = $AgentVersion
    machineGuid  = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography').MachineGuid
    hostname     = $env:COMPUTERNAME
    serialNumber = $bios.SerialNumber
    manufacturer = $cs.Manufacturer
    model        = $cs.Model
    os           = [ordered]@{
      caption = $os.Caption
      version = $cv.DisplayVersion
      build   = "$($os.BuildNumber).$($cv.UBR)"
      edition = $cv.EditionID
    }
    domain       = [ordered]@{ partOfDomain = [bool]$cs.PartOfDomain; name = $cs.Domain }
    dsreg        = Safe 'dsreg' { Get-DsregStatus } ([ordered]@{})
    mdm          = Get-MdmState
    sccmClient   = [bool](Get-Service -Name CcmExec -ErrorAction SilentlyContinue)
    tpm          = Get-TpmState
    secureBoot   = Safe 'secureBoot' { [bool](Confirm-SecureBootUEFI) }
    winreEnabled = Get-WinreEnabled
    bitlocker    = Get-BitlockerState
    network      = Get-NetworkState
    disk         = [ordered]@{
      freeGb  = if ($disk) { [math]::Round($disk.FreeSpace / 1GB) } else { $null }
      totalGb = if ($disk) { [math]::Round($disk.Size / 1GB) } else { $null }
    }
    consoleUser  = $cs.UserName
    lastBoot     = $os.LastBootUpTime.ToUniversalTime().ToString('o')
    profiles     = $profiles
    profilesMeasuredAt = $State.profilesMeasuredAt
    apps         = Safe 'apps' { Get-InstalledApps } @()
  }
}

# ═════════════════════════════════════════════════════════════════════════════
# Check-in
# ═════════════════════════════════════════════════════════════════════════════

# Renvoie $null si tout va bien (ou si ce n'est pas encore l'heure), sinon la cause de l'échec.
function Invoke-Checkin {
  $state = Get-State
  if (-not $Force -and $state.nextCheckinAt -and (Get-Date) -lt [datetime]$state.nextCheckinAt) { return $null }
  $failure = $null

  $report = Get-Report $state
  $json = $report | ConvertTo-Json -Depth 6 -Compress
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $headers = @{}
  $hasToken = Test-Path $TokenPath
  if ($hasToken) { $headers['Authorization'] = 'Bearer ' + (Get-Content $TokenPath -Raw).Trim() }
  else { $headers['X-Enrollment-Key'] = $EnrollmentKey }

  try {
    $res = Invoke-RestMethod -Method Post -Uri "$($ApiUrl.TrimEnd('/'))/api/device-agent/checkin" -Headers $headers `
      -Body ([Text.Encoding]::UTF8.GetBytes($json)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 60 -UseBasicParsing
    if ($res.deviceToken) {
      Set-Content -Path $TokenPath -Value $res.deviceToken -NoNewline -Encoding ASCII
      Write-Log "Enregistré auprès de la DSI App (agent $($res.agentId))"
    }
    $minutes = if ($res.nextCheckinMinutes -gt 0) { [int]$res.nextCheckinMinutes } else { 240 }
    $state.nextCheckinAt = (Get-Date).AddMinutes($minutes).ToString('o')
    Write-Log "Check-in OK, prochain dans $minutes min"
    # La bascule est pilotée par le sondage léger Invoke-MigrationPoll (plus réactif), pas ici.
  } catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status -eq 401 -and $hasToken) {
      # Jeton réinitialisé par la DSI : on se ré-enrôle au prochain passage
      Remove-Item $TokenPath -Force -ErrorAction SilentlyContinue
      $state.nextCheckinAt = $null
      $failure = 'Jeton refusé (401) : supprimé, ré-enrôlement au prochain passage'
    } elseif ($status -eq 401) {
      $failure = 'Clé d''enrôlement refusée (401) : $EnrollmentKey du script différente de DEVICE_AGENT_ENROLLMENT_KEY côté API'
    } elseif ($status -eq 409) {
      $state.nextCheckinAt = (Get-Date).AddHours(24).ToString('o')
      $failure = 'Poste déjà enregistré sans jeton local (409) : cliquer « Réinitialiser l''agent » dans la DSI App'
    } elseif ($status) {
      $failure = "Réponse HTTP $status de $ApiUrl : $($_.Exception.Message)"
    } else {
      $failure = "DSI App injoignable ($ApiUrl) : réseau, proxy ou filtrage ($($_.Exception.Message))"
    }
    Write-Log "Check-in en échec : $failure"
  }
  Save-State $state
  return $failure
}

# ═════════════════════════════════════════════════════════════════════════════
# Bascule vers Ouihelp : réinstallation propre (lot 3)
# ═════════════════════════════════════════════════════════════════════════════
#
# Ordre reçu dans la réponse du check-in, uniquement si la DSI a programmé CE poste.
#  1. staging : contrôles (aucune session, WinRE, alimentation), téléchargement du PPKG,
#     export des Wi-Fi, empreinte Autopilot, dépôt des fichiers dans C:\Recovery\OEM.
#  2. staged → cleanup : le serveur retire le PC d'Autopilot ONELA ; l'agent attend « ready ».
#  3. ready : réinitialisation locale (RemoteWipe/doWipe = « Supprimer tout »).
# Pendant la réinitialisation, DsiReset.cmd (point d'extensibilité FactoryReset_AfterImageApply)
# copie C:\DSI et Panther\unattend.xml dans le nouveau Windows. L'unattend saute l'installation
# sans réseau, crée dsi-secours et une tâche SYSTEM qui lance FirstLogon.ps1 : Wi-Fi restaurés,
# PPKG Ouihelp installé, jonction vérifiée, secrets effacés, redémarrage.

$MigDir     = Join-Path $Root 'migration'
$OemDir     = Join-Path $env:SystemDrive 'Recovery\OEM'
$PayloadDir = Join-Path $OemDir 'DSI'
$ResetCfg   = Join-Path $OemDir 'ResetConfig.xml'
$ResetCmd   = Join-Path $OemDir 'DsiReset.cmd'

# Windows PowerShell 5.1 décode la réponse d'Invoke-RestMethod en ISO-8859-1 : les messages
# français de la DSI App arrivaient avec « Ã  » au lieu de « à ». On lit les octets et on les
# décode en UTF-8 avant d'analyser le JSON.
function Invoke-Api([string]$Method, [string]$Path, $Body = $null, [string]$OutFile = $null) {
  $headers = @{ Authorization = 'Bearer ' + (Get-Content $TokenPath -Raw).Trim() }
  $uri = "$($ApiUrl.TrimEnd('/'))/api/device-agent$Path"
  if ($OutFile) { return Invoke-WebRequest -Method $Method -Uri $uri -Headers $headers -OutFile $OutFile -TimeoutSec 120 -UseBasicParsing }
  $req = @{ Method = $Method; Uri = $uri; Headers = $headers; TimeoutSec = 60; UseBasicParsing = $true }
  if ($null -ne $Body) {
    $req['Body'] = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 4 -Compress))
    $req['ContentType'] = 'application/json; charset=utf-8'
  }
  $res = Invoke-WebRequest @req
  $bytes = if ($res.RawContentStream) { $res.RawContentStream.ToArray() } else { [byte[]]@() }
  if ($bytes.Length -eq 0) { return $null }
  return [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
}

function Send-Progress([string]$Step, [string]$Status, [string]$Message, [hashtable]$Extra = @{}) {
  Write-Log "[bascule:$Step/$Status] $Message"
  $body = @{ step = $Step; status = $Status; message = $Message }
  foreach ($k in $Extra.Keys) { $body[$k] = $Extra[$k] }
  try { $null = Invoke-Api 'POST' '/migration/progress' $body } catch { Write-Log "Compte rendu non transmis : $($_.Exception.Message)" }
}

function Get-InteractiveUser {
  $u = (Get-CimInstance Win32_ComputerSystem).UserName
  if ($u) { return $u }
  $p = Get-Process -Name explorer -IncludeUserName -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($p) { return $p.UserName }
  return $null
}

function Test-PowerOk {
  $b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $b) { return $true }                     # PC fixe
  if ($b.BatteryStatus -eq 2) { return $true }      # sur secteur
  return ($b.EstimatedChargeRemaining -ge 50)
}

# Session fermée, le PC se met en veille sur l'écran de verrouillage et l'agent ne tourne
# plus → bascule figée. On neutralise veille / mise en veille prolongée / extinction de
# l'écran sur secteur ET sur batterie, le temps de la bascule. Idempotent, rejoué à chaque
# passage. Réglages perdus de toute façon à la réinstallation ; on les rétablit à l'annulation.
function Disable-Sleep {
  foreach ($c in @(
    'standby-timeout-ac 0', 'standby-timeout-dc 0',
    'hibernate-timeout-ac 0', 'hibernate-timeout-dc 0',
    'monitor-timeout-ac 0', 'monitor-timeout-dc 0',
    'disk-timeout-ac 0', 'disk-timeout-dc 0'
  )) {
    $null = & powercfg.exe /change $c.Split(' ')[0] $c.Split(' ')[1] 2>$null
  }
  # Fermeture du capot = « ne rien faire » sur secteur et sur batterie (indices 0/1)
  foreach ($pa in @('SUB_BUTTONS LIDACTION')) {
    $null = & powercfg.exe /setacvalueindex SCHEME_CURRENT $pa.Split(' ')[0] $pa.Split(' ')[1] 0 2>$null
    $null = & powercfg.exe /setdcvalueindex SCHEME_CURRENT $pa.Split(' ')[0] $pa.Split(' ')[1] 0 2>$null
  }
  $null = & powercfg.exe /setactive SCHEME_CURRENT 2>$null
  Write-Log 'Veille / extinction écran / action capot neutralisées pour la bascule'
}

function Restore-Sleep {
  # Rétablit les délais par défaut du profil équilibré (après une annulation)
  $null = & powercfg.exe /restoredefaultschemes 2>$null
  Write-Log 'Réglages d''alimentation par défaut rétablis'
}

function Get-HardwareHash {
  $d = Get-CimInstance -Namespace 'root/cimv2/mdm/dmmap' -ClassName 'MDM_DevDetail_Ext01' -Filter "InstanceID='Ext' AND ParentID='./DevDetail'"
  return $d.DeviceHardwareData
}

function Write-Utf8([string]$Path, [string]$Text, [bool]$Bom = $false) {
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($Bom)))
}

# unattend.xml du nouveau Windows. Fonction pure (testable hors Windows).
function New-UnattendXml {
  param(
    [string]$Arch, [string]$AdminGroup, [string]$Password, [string]$UserName, [string]$ComputerName,
    [string]$UiLanguage, [string]$InputLocale, [string]$SystemLocale, [string]$UserLocale, [string]$TimeZone
  )
  $e = { param($v) [Security.SecurityElement]::Escape($v) }
  $common = "processorArchitecture=`"$Arch`" publicKeyToken=`"31bf3856ad364e35`" language=`"neutral`" versionScope=`"nonSxS`""
  $task = 'schtasks.exe /Create /TN "DSI\Bascule Ouihelp" /RU SYSTEM /RL HIGHEST /SC ONLOGON /F /TR "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\DSI\FirstLogon.ps1"'
  return @"
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" $common>
      <ComputerName>$(& $e $ComputerName)</ComputerName>
    </component>
    <component name="Microsoft-Windows-Deployment" $common>
      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add">
          <Order>1</Order>
          <Description>DSI : tache de bascule Ouihelp</Description>
          <Path>$(& $e $task)</Path>
        </RunSynchronousCommand>
      </RunSynchronous>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" $common>
      <InputLocale>$(& $e $InputLocale)</InputLocale>
      <SystemLocale>$(& $e $SystemLocale)</SystemLocale>
      <UILanguage>$(& $e $UiLanguage)</UILanguage>
      <UserLocale>$(& $e $UserLocale)</UserLocale>
    </component>
    <component name="Microsoft-Windows-Shell-Setup" $common>
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <HideLocalAccountScreen>true</HideLocalAccountScreen>
        <ProtectYourPC>3</ProtectYourPC>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>$(& $e $UserName)</Name>
            <Group>$(& $e $AdminGroup)</Group>
            <Password><Value>$(& $e $Password)</Value><PlainText>true</PlainText></Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <AutoLogon>
        <Enabled>true</Enabled>
        <LogonCount>1</LogonCount>
        <Username>$(& $e $UserName)</Username>
        <Password><Value>$(& $e $Password)</Value><PlainText>true</PlainText></Password>
      </AutoLogon>
      <TimeZone>$(& $e $TimeZone)</TimeZone>
    </component>
  </settings>
</unattend>
"@
}

# Exécuté par l'environnement de récupération (étape D de « Supprimer tout ») : ASCII, sans GUI.
$DsiResetCmd = @'
@echo off
for /F "tokens=1,2,3 delims= " %%A in ('reg query "HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\RecoveryEnvironment" /v TargetOS') DO SET TARGETOS=%%C
for /F "tokens=1 delims=\" %%A in ('Echo %TARGETOS%') DO SET TARGETOSDRIVE=%%A
mkdir "%TARGETOSDRIVE%\DSI" >nul 2>&1
echo DsiReset %DATE% %TIME% TARGETOS=%TARGETOS% > "%TARGETOSDRIVE%\DSI\reset.log"
xcopy "%TARGETOSDRIVE%\Recovery\OEM\DSI\*" "%TARGETOSDRIVE%\DSI\" /e /h /y /i >> "%TARGETOSDRIVE%\DSI\reset.log" 2>&1
mkdir "%TARGETOS%\Panther" >nul 2>&1
copy /y "%TARGETOSDRIVE%\Recovery\OEM\DSI\unattend.xml" "%TARGETOS%\Panther\unattend.xml" >> "%TARGETOSDRIVE%\DSI\reset.log" 2>&1
echo fin %DATE% %TIME% >> "%TARGETOSDRIVE%\DSI\reset.log"
exit /b 0
'@

$ResetConfigXml = @'
<?xml version="1.0" encoding="utf-8"?>
<!-- DSI ONELA : bascule Ouihelp (sauvegarde de l'original : ResetConfig.xml.dsi-backup) -->
<Reset>
  <Run Phase="FactoryReset_AfterImageApply">
    <Path>DsiReset.cmd</Path>
    <Duration>5</Duration>
  </Run>
</Reset>
'@

# Lancé dans le NOUVEAU Windows par la tâche SYSTEM « DSI\Bascule Ouihelp » (ouverture de
# session de dsi-secours). L'agent n'existe plus : compte rendu via le jeton de bascule.
$FirstLogonPs1 = @'
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$Root = 'C:\DSI'
$Log  = Join-Path $Root 'firstlogon.log'
$Lock = Join-Path $Root 'firstlogon.lock'
$Done = Join-Path $Root 'firstlogon.done'
function Log([string]$m) { Add-Content -Path $Log -Value ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $m) -Encoding UTF8 }
if (Test-Path $Done) { exit 0 }
if ((Test-Path $Lock) -and ((Get-Date) - (Get-Item $Lock).LastWriteTime).TotalMinutes -lt 60) { exit 0 }
Set-Content -Path $Lock -Value (Get-Date).ToString('o')

$cfg = Get-Content (Join-Path $Root 'migration.json') -Raw -Encoding UTF8 | ConvertFrom-Json
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Report([string]$Step, [string]$Status, [string]$Message, [bool]$Joined = $false) {
  Log "[$Step/$Status] $Message"
  try {
    $body = @{ step = $Step; status = $Status; message = $Message; joined = $Joined } | ConvertTo-Json -Compress
    $null = Invoke-RestMethod -Method Post -Uri "$($cfg.apiUrl)/api/device-agent/migration/report" `
      -Headers @{ 'X-Migration-Token' = $cfg.reportToken } -Body ([Text.Encoding]::UTF8.GetBytes($body)) `
      -ContentType 'application/json; charset=utf-8' -TimeoutSec 30 -UseBasicParsing
  } catch { Log "Compte rendu non transmis : $($_.Exception.Message)" }
}

# Clés Wi-Fi en clair, jeton en bloc, mot de passe de l'unattend : rien ne doit rester.
function Remove-Secrets {
  Remove-Item (Join-Path $Root 'wifi') -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $Root 'ouihelp.ppkg'), (Join-Path $Root 'unattend.xml') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $env:SystemRoot 'Panther\unattend.xml') -Force -ErrorAction SilentlyContinue
  $oem = Join-Path $env:SystemDrive 'Recovery\OEM'
  Remove-Item (Join-Path $oem 'DSI') -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $oem 'DsiReset.cmd') -Force -ErrorAction SilentlyContinue
  $rc = Join-Path $oem 'ResetConfig.xml'
  if (Test-Path "$rc.dsi-backup") { Move-Item "$rc.dsi-backup" $rc -Force } else { Remove-Item $rc -Force -ErrorAction SilentlyContinue }
  $wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty -Path $wl -Name AutoAdminLogon -Value '0' -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $wl -Name DefaultPassword -ErrorAction SilentlyContinue
}

$ok = $false
try {
  $wifi = @(Get-ChildItem (Join-Path $Root 'wifi') -Filter '*.xml' -ErrorAction SilentlyContinue)
  foreach ($x in $wifi) { $null = & netsh.exe wlan add profile filename="$($x.FullName)" user=all }
  Log "Nouveau Windows démarré, $($wifi.Count) profil(s) Wi-Fi restauré(s)"

  $online = $false
  $deadline = (Get-Date).AddMinutes(20)
  while ((Get-Date) -lt $deadline) {
    try { $null = Invoke-WebRequest "$($cfg.apiUrl)/api/health" -UseBasicParsing -TimeoutSec 10; $online = $true; break } catch { Start-Sleep -Seconds 15 }
  }
  if (-not $online) { throw 'Pas de réseau 20 min après la réinstallation (Wi-Fi non restauré ?)' }
  Report 'reseau' 'ok' "Windows réinstallé, réseau rétabli ($($wifi.Count) profil(s) Wi-Fi restauré(s))"

  # Une stratégie peut interdire l'ajout de PPKG (correctif repris du script de migration Intune)
  $sec = 'HKLM:\SOFTWARE\Microsoft\PolicyManager\current\device\Security'
  if (-not (Test-Path $sec)) { $null = New-Item -Path $sec -Force }
  Set-ItemProperty -Path $sec -Name AllowAddProvisioningPackage -Value 1 -Type DWord
  $null = Install-ProvisioningPackage -PackagePath (Join-Path $Root 'ouihelp.ppkg') -ForceInstall -QuietInstall
  Report 'ppkg' 'info' 'PPKG Ouihelp installé, attente de la jonction à Entra Ouihelp'

  $joined = $false
  $deadline = (Get-Date).AddMinutes(15)
  while ((Get-Date) -lt $deadline) {
    $s = (& dsregcmd.exe /status) -join "`n"
    if ($s -match 'AzureAdJoined\s*:\s*YES' -and $s -match ('TenantId\s*:\s*' + [regex]::Escape($cfg.ouihelpTenantId))) { $joined = $true; break }
    Start-Sleep -Seconds 20
  }
  if (-not $joined) { throw 'PPKG installé mais PC non joint à Entra Ouihelp après 15 min' }

  try {
    $v = Get-BitLockerVolume -MountPoint $env:SystemDrive
    foreach ($kp in ($v.KeyProtector | Where-Object { $_.KeyProtectorType -eq 'RecoveryPassword' })) {
      $null = BackupToAAD-BitLockerKeyProtector -MountPoint $env:SystemDrive -KeyProtectorId $kp.KeyProtectorId
    }
  } catch { Log "Clé BitLocker non enregistrée chez Ouihelp : $($_.Exception.Message)" }

  # Nom DSI (ONL-<site>-<série>) appliqué APRÈS le PPKG, qui peut imposer le sien
  if ($cfg.computerName -and $env:COMPUTERNAME -ne $cfg.computerName) {
    try { Rename-Computer -NewName $cfg.computerName -Force; Log "Renommé en $($cfg.computerName) (effectif au redémarrage)" }
    catch { Log "Renommage en $($cfg.computerName) impossible : $($_.Exception.Message)" }
  }

  Report 'jonction' 'ok' "Joint à Entra Ouihelp, nom $($cfg.computerName) ; redémarrage vers l'écran de connexion" $true
  $ok = $true
} catch {
  Report 'echec' 'error' $_.Exception.Message
} finally {
  Remove-Secrets
  $null = & schtasks.exe /Delete /TN 'DSI\Bascule Ouihelp' /F
  $null = New-Item $Done -ItemType File -Force
  Remove-Item $Lock -Force -ErrorAction SilentlyContinue
}
if ($ok) {
  Remove-Item (Join-Path $Root 'migration.json') -Force -ErrorAction SilentlyContinue
  & shutdown.exe /r /t 30 /c 'Configuration Ouihelp terminée : redémarrage'
}
'@

function Remove-MigrationPayload {
  Get-Process -Name 'DsiMajPc' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item $PromptScript, $PromptChoice -Force -ErrorAction SilentlyContinue
  Remove-Item $PromptDir -Recurse -Force -ErrorAction SilentlyContinue
  $null = & schtasks.exe /Delete /TN 'DSI\Avertissement migration' /F 2>$null
  Remove-Item $PayloadDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $ResetCmd -Force -ErrorAction SilentlyContinue
  if (Test-Path "$ResetCfg.dsi-backup") { Move-Item "$ResetCfg.dsi-backup" $ResetCfg -Force }
  elseif ((Test-Path $ResetCfg) -and ((Get-Content $ResetCfg -Raw) -match 'DSI ONELA')) { Remove-Item $ResetCfg -Force }
  Remove-Item $MigDir -Recurse -Force -ErrorAction SilentlyContinue
}

function New-MigrationPayload($Order) {
  if (-not (Test-Path $MigDir)) { $null = New-Item -ItemType Directory -Path $MigDir -Force }
  $null = New-Item -ItemType Directory -Path $PayloadDir -Force
  $null = New-Item -ItemType Directory -Path (Join-Path $PayloadDir 'wifi') -Force

  # PPKG : remis par la DSI App, vérifié par son empreinte SHA-256
  $ppkg = Join-Path $PayloadDir 'ouihelp.ppkg'
  $null = Invoke-Api 'GET' '/migration/package' $null $ppkg
  $hash = (Get-FileHash -Path $ppkg -Algorithm SHA256).Hash.ToLower()
  if ($hash -ne $Order.packageSha256) { throw "PPKG altéré : empreinte $hash au lieu de $($Order.packageSha256)" }

  # Wi-Fi enregistrés, clés comprises : restaurés par FirstLogon.ps1 puis effacés
  $null = & netsh.exe wlan export profile key=clear folder="$(Join-Path $PayloadDir 'wifi')"
  $wifiCount = @(Get-ChildItem (Join-Path $PayloadDir 'wifi') -Filter '*.xml' -ErrorAction SilentlyContinue).Count

  $cfg = [ordered]@{
    apiUrl          = $ApiUrl.TrimEnd('/')
    reportToken     = $Order.reportToken
    ouihelpTenantId = $Order.ouihelpTenantId
    computerName    = $Order.computerName
    hostname        = $env:COMPUTERNAME
  }
  Write-Utf8 (Join-Path $PayloadDir 'migration.json') ($cfg | ConvertTo-Json)
  Write-Utf8 (Join-Path $PayloadDir 'FirstLogon.ps1') $FirstLogonPs1 $true

  $adminGroup = (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544').Translate([Security.Principal.NTAccount]).Value.Split('\')[-1]
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
  $inputLocale = Safe 'inputLocale' { (Get-WinUserLanguageList)[0].InputMethodTips[0] } '040c:0000040c'
  $unattend = New-UnattendXml -Arch $arch -AdminGroup $adminGroup -Password $Order.breakglassPassword -UserName $Order.breakglassUser -ComputerName $Order.computerName `
    -UiLanguage (Get-UICulture).Name -InputLocale $inputLocale -SystemLocale (Get-WinSystemLocale).Name `
    -UserLocale (Get-Culture).Name -TimeZone (Get-TimeZone).Id
  Write-Utf8 (Join-Path $PayloadDir 'unattend.xml') $unattend

  # Point d'extensibilité de la réinitialisation ; on garde l'éventuel ResetConfig.xml du constructeur
  if ((Test-Path $ResetCfg) -and -not (Test-Path "$ResetCfg.dsi-backup") -and -not ((Get-Content $ResetCfg -Raw) -match 'DSI ONELA')) {
    Copy-Item $ResetCfg "$ResetCfg.dsi-backup" -Force
  }
  [IO.File]::WriteAllText($ResetCmd, $DsiResetCmd, [Text.Encoding]::ASCII)
  Write-Utf8 $ResetCfg $ResetConfigXml
  return $wifiCount
}

# Marqueur d'accord de l'utilisateur, persistant d'un passage à l'autre (SYSTEM)
$ConsentMarker = Join-Path $MigDir 'consented'
# Fichiers d'échange avec la session utilisateur. Le choix est écrit dans C:\Users\Public, seul
# endroit où un utilisateur standard peut écrire (C:\ProgramData\DSI est réservé à SYSTEM/Administrateurs).
# La fenêtre est un petit .exe compilé sur place : pas de PowerShell côté utilisateur, donc
# insensible à la stratégie d'exécution et au mode de langage restreint.
$PromptDir    = Join-Path $env:ProgramData 'DSI-Ui'
$PromptExe    = Join-Path $PromptDir 'DsiMajPc.exe'
$PromptMsg    = Join-Path $PromptDir 'message.txt'
$PromptScript = Join-Path $env:PUBLIC 'dsi-maj-pc.ps1'   # ancienne fenêtre (≤ 1.1.6), supprimée au nettoyage
$PromptChoice = Join-Path $env:PUBLIC 'dsi-maj-choix.txt'
$PromptSnoozeUntil = Join-Path $MigDir 'snooze-until'

$PromptSource = @'
using System;
using System.IO;
using System.Text;
using System.Drawing;
using System.Windows.Forms;
public static class DsiMajPc {
  // Arguments : fichier de choix, fichier du message (UTF-8), durée du report (min), report permis (1/0)
  [STAThread]
  public static int Main(string[] a) {
    string choice = a[0];
    string msg = File.ReadAllText(a[1], Encoding.UTF8);
    int later = int.Parse(a[2]);
    bool allow = a[3] == "1";
    Application.EnableVisualStyles();
    Form f = new Form();
    f.Text = "Mise \u00e0 jour de votre PC \u2014 DSI";
    f.ClientSize = new Size(520, 200);
    f.StartPosition = FormStartPosition.CenterScreen;
    f.TopMost = true;
    f.FormBorderStyle = FormBorderStyle.FixedDialog;
    f.MaximizeBox = false; f.MinimizeBox = false;
    Label l = new Label();
    l.Text = msg;
    l.Font = new Font("Segoe UI", 11);
    l.SetBounds(20, 20, 480, 110);
    f.Controls.Add(l);
    Button go = new Button();
    go.Text = "D\u00e9marrer maintenant";
    go.SetBounds(310, 145, 190, 36);
    go.Click += delegate { File.WriteAllText(choice, "start"); f.Close(); };
    f.Controls.Add(go);
    f.AcceptButton = go;
    if (allow) {
      Button lt = new Button();
      lt.Text = "Plus tard (" + later + " min)";
      lt.SetBounds(150, 145, 150, 36);
      lt.Click += delegate { File.WriteAllText(choice, "snooze"); f.Close(); };
      f.Controls.Add(lt);
    }
    f.Shown += delegate { f.Activate(); };
    Application.Run(f);
    return 0;
  }
}
'@

# Lance un processus dans les sessions ouvertes (console ou bureau à distance), depuis SYSTEM,
# avec le jeton de l'utilisateur. Vérifie que le processus tourne encore après 4 s : s'il s'est
# arrêté, son code de sortie est journalisé (cause concrète au lieu d'un faux « affiché »).
$script:UserSessionLauncherReady = $false
function Initialize-UserSessionLauncher {
  if ($script:UserSessionLauncherReady) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace DsiNative {
  public static class UserSession {
    [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
    [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct WTS_SESSION_INFO { public int SessionId; public IntPtr pWinStationName; public int State; }
    [DllImport("kernel32.dll")] static extern int WTSGetActiveConsoleSessionId();
    [DllImport("wtsapi32.dll", SetLastError=true)] static extern bool WTSEnumerateSessions(IntPtr hServer, int Reserved, int Version, out IntPtr ppSessionInfo, out int pCount);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr pMemory);
    [DllImport("wtsapi32.dll", SetLastError=true)] static extern bool WTSQueryUserToken(int SessionId, out IntPtr phToken);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr hToken, uint dwDesiredAccess, IntPtr lpTokenAttributes, int ImpersonationLevel, int TokenType, out IntPtr phNewToken);
    [DllImport("userenv.dll", SetLastError=true)] static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);
    [DllImport("userenv.dll", SetLastError=true)] static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);
    [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessAsUser(IntPtr hToken, string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr hObject);

    // Sessions actives (état WTSActive = 0) + session console, sans doublon
    static List<int> ActiveSessions() {
      List<int> ids = new List<int>();
      int console = WTSGetActiveConsoleSessionId();
      if (console != -1) ids.Add(console);
      IntPtr p; int n;
      if (WTSEnumerateSessions(IntPtr.Zero, 0, 1, out p, out n)) {
        int size = Marshal.SizeOf(typeof(WTS_SESSION_INFO));
        for (int i = 0; i < n; i++) {
          WTS_SESSION_INFO s = (WTS_SESSION_INFO)Marshal.PtrToStructure(new IntPtr(p.ToInt64() + i * size), typeof(WTS_SESSION_INFO));
          if (s.State == 0 && s.SessionId != 0 && !ids.Contains(s.SessionId)) ids.Add(s.SessionId);
        }
        WTSFreeMemory(p);
      }
      return ids;
    }

    // Renvoie une ligne par session : « session N : processus P » ou la cause de l'échec.
    public static string[] Launch(string commandLine) {
      List<string> res = new List<string>();
      foreach (int sid in ActiveSessions()) {
        IntPtr userToken, primaryToken = IntPtr.Zero, env = IntPtr.Zero;
        if (!WTSQueryUserToken(sid, out userToken)) { res.Add("session " + sid + " : aucun utilisateur (erreur " + Marshal.GetLastWin32Error() + ")"); continue; }
        try {
          if (!DuplicateTokenEx(userToken, 0x02000000u, IntPtr.Zero, 2, 1, out primaryToken)) { res.Add("session " + sid + " : DuplicateTokenEx erreur " + Marshal.GetLastWin32Error()); continue; }
          CreateEnvironmentBlock(out env, primaryToken, false);
          STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si); si.lpDesktop = @"winsta0\default";
          PROCESS_INFORMATION pi;
          // CREATE_BREAKAWAY_FROM_JOB : la tâche planifiée de l'agent tourne dans un « job » dont les
          // restrictions empêchent l'interface graphique de s'initialiser (code 0x8007045A).
          // Si le job refuse la sortie (erreur 5), on retente sans.
          bool ok = CreateProcessAsUser(primaryToken, null, commandLine, IntPtr.Zero, IntPtr.Zero, false, 0x01000400u, env, null, ref si, out pi);
          if (!ok && Marshal.GetLastWin32Error() == 5)
            ok = CreateProcessAsUser(primaryToken, null, commandLine, IntPtr.Zero, IntPtr.Zero, false, 0x00000400u, env, null, ref si, out pi);
          if (!ok) { res.Add("session " + sid + " : CreateProcessAsUser erreur " + Marshal.GetLastWin32Error()); continue; }
          if (WaitForSingleObject(pi.hProcess, 4000) == 0) {
            uint code; GetExitCodeProcess(pi.hProcess, out code);
            res.Add("session " + sid + " : processus " + pi.dwProcessId + " arrêté aussitôt (code 0x" + code.ToString("X") + ")");
          } else {
            res.Add("session " + sid + " : processus " + pi.dwProcessId + " OK");
          }
          CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
        } finally {
          if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);
          if (primaryToken != IntPtr.Zero) CloseHandle(primaryToken);
          CloseHandle(userToken);
        }
      }
      if (res.Count == 0) res.Add("aucune session active");
      return res.ToArray();
    }
  }
}
'@
  $script:UserSessionLauncherReady = $true
}

# Compile la fenêtre (une fois par version d'agent) dans un dossier lisible par les utilisateurs
# mais modifiable seulement par SYSTEM/Administrateurs.
function Initialize-PromptExe {
  $stamp = Join-Path $PromptDir "version-$AgentVersion"
  if ((Test-Path $PromptExe) -and (Test-Path $stamp)) { return }
  if (Test-Path $PromptDir) { Remove-Item $PromptDir -Recurse -Force }
  $null = New-Item -ItemType Directory -Path $PromptDir -Force
  & icacls.exe $PromptDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  Add-Type -TypeDefinition $PromptSource -ReferencedAssemblies System.Windows.Forms, System.Drawing `
    -OutputAssembly $PromptExe -OutputType WindowsApplication
  Set-Content -Path $stamp -Value (Get-Date).ToString('o') -Encoding ASCII
}

$PromptTaskPath = '\DSI\'
$PromptTaskName = 'Avertissement migration'
function Start-PromptViaTask([string]$User, [string]$Exe, [string]$Arguments) {
  try {
    $action = New-ScheduledTaskAction -Execute $Exe -Argument $Arguments
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 4)
    Register-ScheduledTask -TaskPath $PromptTaskPath -TaskName $PromptTaskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskPath $PromptTaskPath -TaskName $PromptTaskName
    Start-Sleep -Seconds 5
    if (Get-Process -Name 'DsiMajPc' -ErrorAction SilentlyContinue) { return 'OK' }
    $info = Get-ScheduledTaskInfo -TaskPath $PromptTaskPath -TaskName $PromptTaskName
    return ('fenêtre absente (résultat 0x{0:X})' -f ([int64]$info.LastTaskResult -band 4294967295))
  } catch {
    return "erreur $($_.Exception.Message)"
  }
}

# Affiche à l'utilisateur connecté, dans SA session, une fenêtre « Démarrer / Plus tard ».
# Renvoie 'shown' (lancée et toujours ouverte), 'open' (déjà affichée) ou 'failed'.
function Show-MigrationPrompt([string]$User, $Order) {
  try {
    if (Get-Process -Name 'DsiMajPc' -ErrorAction SilentlyContinue) { return 'open' }
    Initialize-PromptExe
    [IO.File]::WriteAllText($PromptMsg, [string]$Order.promptMessage, (New-Object Text.UTF8Encoding($false)))
    Remove-Item $PromptChoice, $PromptScript -Force -ErrorAction SilentlyContinue
    $allow = if ($Order.snoozeCount -lt $Order.maxSnoozes) { '1' } else { '0' }
    $cmd = "`"$PromptExe`" `"$PromptChoice`" `"$PromptMsg`" $([int]$Order.snoozeMinutes) $allow"
    Initialize-UserSessionLauncher
    $lines = [DsiNative.UserSession]::Launch($cmd)
    Write-Log "Avertissement ($User) : $($lines -join ' ; ')"
    if (($lines | Where-Object { $_ -like '* OK' }).Count -gt 0) { return 'shown' }
    # Secours : tâche planifiée au nom de l'utilisateur, lancée par le Planificateur lui-même
    # (donc hors du job de l'agent), dans sa session interactive.
    $viaTask = Start-PromptViaTask $User $PromptExe "`"$PromptChoice`" `"$PromptMsg`" $([int]$Order.snoozeMinutes) $allow"
    Write-Log "Avertissement ($User) par tâche planifiée : $viaTask"
    if ($viaTask -eq 'OK') { return 'shown' }
    $script:PromptError = "$($lines -join ' ; ') ; tâche planifiée : $viaTask"
    return 'failed'
  } catch {
    $script:PromptError = $_.Exception.Message
    Write-Log "Affichage de l'avertissement impossible : $($_.Exception.Message)"
    return 'failed'
  }
}

function Start-Reset {
  if (-not (Test-Path (Join-Path $PayloadDir 'unattend.xml')) -or -not (Test-Path $ResetCfg)) {
    Send-Progress 'reinitialisation' 'error' 'Fichiers de bascule absents de C:\Recovery\OEM : préparation à refaire' @{ fatal = $true }
    return
  }
  $user = Get-InteractiveUser
  # Session ouverte : on ne bascule que si l'utilisateur a cliqué « Démarrer » (marqueur persistant)
  if ($user -and -not (Test-Path $ConsentMarker)) { Write-Log "Bascule prête, session ouverte ($user) sans accord : nouvel essai au prochain passage"; return }
  # Compte rendu AVANT : la réinitialisation peut couper l'agent à tout moment
  Send-Progress 'reinitialisation' 'info' 'Réinitialisation de Windows lancée (Supprimer tout)' @{ resetTriggered = $true }
  try {
    $ns = 'root\cimv2\mdm\dmmap'
    $session = New-CimSession
    $instance = Get-CimInstance -Namespace $ns -ClassName 'MDM_RemoteWipe' -Filter "ParentID='./Vendor/MSFT' and InstanceID='RemoteWipe'"
    $params = New-Object Microsoft.Management.Infrastructure.CimMethodParametersCollection
    $params.Add([Microsoft.Management.Infrastructure.CimMethodParameter]::Create('param', '', 'String', 'In'))
    $null = $session.InvokeMethod($ns, $instance, 'doWipeMethod', $params)
    Write-Log 'doWipeMethod accepté : redémarrage imminent'
  } catch {
    Send-Progress 'reinitialisation' 'error' "Réinitialisation refusée par Windows : $($_.Exception.Message)" @{ fatal = $true }
  }
}

# Session ouverte : accord de l'utilisateur. Renvoie $true quand l'agent peut agir (personne
# connecté, ou accord déjà donné), $false sinon : l'avertissement est affiché ou réaffiché, un
# report est en cours, ou le mode « hors session » attend la fermeture de la session.
function Test-MigrationConsent($Order) {
  $user = Get-InteractiveUser
  if (-not $user) { return $true }
  if (Test-Path $ConsentMarker) { return $true }
  if (-not $Order.promptUser) {
    Send-Progress 'attente' 'info' "Session ouverte ($user) : la bascule attend qu'elle soit fermée"
    return $false
  }
  $choice = if (Test-Path $PromptChoice) { (Get-Content $PromptChoice -Raw -ErrorAction SilentlyContinue).Trim() } else { $null }
  if ($choice -eq 'start') {
    Remove-Item $PromptChoice -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $MigDir)) { $null = New-Item -ItemType Directory -Path $MigDir -Force }
    Set-Content -Path $ConsentMarker -Value (Get-Date).ToString('o') -Encoding ASCII
    Send-Progress 'accord' 'ok' "$user a cliqué « Démarrer » : bascule en cours"
    return $true
  }
  if ($choice -eq 'snooze') {
    Remove-Item $PromptChoice -Force -ErrorAction SilentlyContinue
    Set-Content -Path $PromptSnoozeUntil -Value (Get-Date).AddMinutes($Order.snoozeMinutes).ToString('o') -Encoding ASCII
    Send-Progress 'report' 'info' "Mise à jour reportée par $user" @{ snoozed = $true }
    return $false
  }
  # Pas encore de réponse : on (ré)affiche l'avertissement, sauf pendant un report en cours
  $until = if (Test-Path $PromptSnoozeUntil) { try { [datetime](Get-Content $PromptSnoozeUntil -Raw) } catch { [datetime]::MinValue } } else { [datetime]::MinValue }
  if ((Get-Date) -ge $until) {
    switch (Show-MigrationPrompt $user $Order) {
      'shown'  { Send-Progress 'avertissement' 'info' "Avertissement affiché à $user (en attente de son accord)" }
      'failed' { Send-Progress 'avertissement' 'error' "Impossible d'afficher l'avertissement à $user ($($script:PromptError)) : nouvel essai au prochain passage" }
      # 'open' : la fenêtre attend déjà une réponse, rien à faire
    }
  }
  return $false
}

# Attend que le serveur ait retiré le PC d'Autopilot ONELA (8 min max par passage : la tâche
# planifiée est limitée à 15 min, mesure des profils comprise).
function Wait-ForReady([string]$Mode = 'reset', $Order = $null) {
  $deadline = (Get-Date).AddMinutes(8)
  while ((Get-Date) -lt $deadline) {
    $s = Safe 'migrationStatus' { Invoke-Api 'GET' '/migration' }
    switch ($s.status) {
      'ready' {
        if ($Mode -eq 'inplace') { Start-InplaceSwitch $Order } else { Start-Reset }
        return
      }
      'failed' {
        Write-Log "Bascule en échec côté serveur : $($s.error)"
        if ($Mode -eq 'inplace') { Remove-InplacePayload } else { Remove-MigrationPayload }
        return
      }
      'cancelled' {
        if ($Mode -eq 'inplace') { Remove-InplacePayload } else { Remove-MigrationPayload }
        return
      }
    }
    Start-Sleep -Seconds 20
  }
  Write-Log 'Retrait Autopilot ONELA pas encore confirmé : nouvel essai au prochain passage'
}

# ═════════════════════════════════════════════════════════════════════════════
# Bascule EN PLACE (mode « inplace »)
# ═════════════════════════════════════════════════════════════════════════════
#
# Windows, les applications et les fichiers restent en place : le poste quitte ONELA, reçoit le
# PPKG Ouihelp, et chaque profil Windows est donné au compte Ouihelp choisi par la DSI
# (Win32_UserProfile.ChangeOwner). L'utilisateur retrouve son bureau en se connectant avec son
# adresse Ouihelp.
#
# Méthode reprise d'IntuneMigration V9 (Steve Weiner), avec quatre différences :
#  - les comptes cibles viennent de l'ordre de la DSI App (profileMap, SID Ouihelp lus par le
#    serveur dans Graph) : l'utilisateur n'a PAS à se connecter à Ouihelp pendant la bascule
#    (ni Az.Accounts, ni Connect-AzAccount, ni session interactive obligatoire) ;
#  - aucun secret Graph sur le poste : toutes les opérations Graph sont faites par le serveur ;
#  - pas d'ouverture de session automatique : V9 déposait un mot de passe en clair dans
#    Winlogon (DefaultPassword). Ici l'agent survit à la bascule et enchaîne les étapes en
#    SYSTEM à chaque réveil ; l'ouverture de session reste possible pour le compte de secours ;
#  - chaque étape est rendue au serveur (journal de la DSI App) et reprise au passage suivant
#    si le poste redémarre ou si une étape échoue.
#
# Trois phases, enregistrées dans inplace.json (aucun secret) :
#  1. « prepared » → bascule : désinstallations, sortie MDM / Entra / domaine, PPKG, redémarrage ;
#  2. « profiles » : transfert des profils aux SID Ouihelp (profil déchargé), redémarrage ;
#  3. « join »     : jonction Ouihelp constatée, clé BitLocker, renommage, compte rendu « joined ».

$InplacePath = Join-Path $MigDir 'inplace.json'
$InplacePpkg = Join-Path $MigDir 'ouihelp.ppkg'
$PoliciesKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
# Au-delà, l'agent s'arrête en rendant compte au lieu de retenter toutes les 2 min.
$SwitchAttempts   = 3
$ProfileAttempts  = 5
$JoinAttempts     = 20
# Espace libre exigé : désinstallations, nouveau profil, PPKG (rien n'est recopié en place).
$InplaceFreeBytes = 10GB

function Set-RegValue([string]$Path, [string]$Name, $Value, [string]$Type = 'DWord') {
  if (-not (Test-Path $Path)) { $null = New-Item -Path $Path -Force }
  Set-ItemProperty -Path $Path -Name $Name -Value $Value -Type $Type -Force
}

function Get-Inplace {
  if (Test-Path $InplacePath) {
    try { return Get-Content $InplacePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
  }
  return $null
}

function Save-Inplace($State) {
  if (-not (Test-Path $MigDir)) { $null = New-Item -ItemType Directory -Path $MigDir -Force }
  $State | ConvertTo-Json -Depth 6 | Set-Content -Path $InplacePath -Encoding UTF8
}

# Compteur de tentatives de la phase en cours. $false = plafond atteint.
function Test-PhaseAttempt($State, [int]$Max) {
  $State.attempts = [int]$State.attempts + 1
  Save-Inplace $State
  return ($State.attempts -le $Max)
}

# Message sur l'écran de verrouillage pendant les deux redémarrages. On ne désactive PAS le
# fournisseur d'identifiants (contrairement à V9) : il est aussi celui du compte de secours.
# Les comptes ONELA, eux, ne peuvent plus s'authentifier dès la sortie du tenant.
function Set-MigrationNotice([string]$Caption, [string]$Text) {
  Safe 'notice' {
    Set-RegValue $PoliciesKey 'legalnoticecaption' $Caption 'String'
    Set-RegValue $PoliciesKey 'legalnoticetext' $Text 'String'
  }
}

function Clear-MigrationNotice {
  Remove-ItemProperty -Path $PoliciesKey -Name 'legalnoticecaption', 'legalnoticetext' -ErrorAction SilentlyContinue
}

function Remove-InplacePayload {
  Get-Process -Name 'DsiMajPc' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item $PromptChoice, $PromptScript -Force -ErrorAction SilentlyContinue
  $null = & schtasks.exe /Delete /TN 'DSI\Avertissement migration' /F 2>$null
  Remove-Item $MigDir -Recurse -Force -ErrorAction SilentlyContinue
}

# Compte local d'administration de secours : seul moyen d'ouvrir une session tant que le poste
# n'est pas joint à Ouihelp, et filet de sécurité si la bascule se bloque. Son mot de passe est
# celui que la DSI App affiche sous « Compte de secours » - il n'est jamais écrit sur le disque.
function New-BreakglassAccount([string]$User, [string]$Password) {
  if (-not $User -or -not $Password) { throw 'Compte de secours absent de l''ordre de bascule' }
  $secure = ConvertTo-SecureString $Password -AsPlainText -Force
  if (Get-LocalUser -Name $User -ErrorAction SilentlyContinue) {
    Set-LocalUser -Name $User -Password $secure -PasswordNeverExpires $true
    Enable-LocalUser -Name $User
  } else {
    $null = New-LocalUser -Name $User -Password $secure -PasswordNeverExpires -AccountNeverExpires -FullName 'Compte de secours DSI'
  }
  $group = (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544').Translate([Security.Principal.NTAccount]).Value.Split('\')[-1]
  Add-LocalGroupMember -Group $group -Member $User -ErrorAction SilentlyContinue
}

# Sortie de l'inscription MDM (Intune ONELA) : certificat d'appareil, clés d'inscription et
# tâches de synchronisation. Sans ça le poste continue d'essayer de parler à Intune ONELA.
function Remove-MdmEnrollment {
  foreach ($c in @(Get-ChildItem Cert:\LocalMachine\My -ErrorAction SilentlyContinue | Where-Object { $_.Issuer -match 'Microsoft Intune MDM Device CA' })) {
    Remove-Item -LiteralPath $c.PSPath -Force -ErrorAction SilentlyContinue
  }
  $base = 'HKLM:\SOFTWARE\Microsoft\Enrollments'
  foreach ($e in @(Get-ChildItem $base -ErrorAction SilentlyContinue)) {
    $p = Get-ItemProperty -LiteralPath $e.PSPath -ErrorAction SilentlyContinue
    if (-not $p.DiscoveryServiceFullURL) { continue }
    $id = Split-Path $e.PSPath -Leaf
    Safe 'mdmTasks' {
      Get-ScheduledTask -TaskPath "\Microsoft\Windows\EnterpriseMgmt\$id\" -ErrorAction SilentlyContinue |
        Unregister-ScheduledTask -Confirm:$false
    }
    foreach ($k in @(
      "$base\$id", "$base\Status\$id",
      "HKLM:\SOFTWARE\Microsoft\EnterpriseResourceManager\Tracked\$id",
      "HKLM:\SOFTWARE\Microsoft\PolicyManager\AdmxInstalled\$id",
      "HKLM:\SOFTWARE\Microsoft\PolicyManager\Providers\$id",
      "HKLM:\SOFTWARE\Microsoft\Provisioning\OMADM\Accounts\$id",
      "HKLM:\SOFTWARE\Microsoft\Provisioning\OMADM\Logger\$id",
      "HKLM:\SOFTWARE\Microsoft\Provisioning\OMADM\Sessions\$id"
    )) { Remove-Item -Path $k -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

# dsregcmd.exe n'existe pas dans SysWOW64 : depuis un processus 32 bits (script Intune non
# forcé en 64 bits), System32 est redirigé et « /leave » ne faisait rien - le poste restait
# dans le tenant d'origine sans aucune erreur (piège relevé dans le script V9).
function Get-DsregPath {
  if (-not [Environment]::Is64BitProcess -and (Test-Path "$env:WINDIR\Sysnative\dsregcmd.exe")) {
    return "$env:WINDIR\Sysnative\dsregcmd.exe"
  }
  return "$env:WINDIR\System32\dsregcmd.exe"
}

function Invoke-EntraLeave {
  $null = Start-Process -FilePath (Get-DsregPath) -ArgumentList '/leave' -Wait -NoNewWindow -PassThru
  Start-Sleep -Seconds 5
  $s = Safe 'dsregApresLeave' { Get-DsregStatus }
  return -not ($s -and $s.azureAdJoined)
}

# Sortie du domaine ONELA avec le compte local de secours. La vue sur un contrôleur de domaine
# fait échouer l'opération : on la coupe le temps de l'appel, puis on REMET les DNS d'origine
# (V9 laissait le poste avec un DNS public statique).
function Invoke-DomainUnjoin([string]$User, [string]$Password) {
  $adapter = Safe 'adaptateur' { (Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1).InterfaceAlias }
  $dns = @()
  if ($adapter) {
    $dns = @(Safe 'dns' { (Get-DnsClientServerAddress -InterfaceAlias $adapter -AddressFamily IPv4).ServerAddresses } @())
  }
  $domain = (Get-CimInstance Win32_ComputerSystem).Domain
  $broken = $false
  if ($adapter -and $domain -and (Test-Connection -ComputerName $domain -Count 2 -Quiet -ErrorAction SilentlyContinue)) {
    Safe 'dnsCoupe' { Set-DnsClientServerAddress -InterfaceAlias $adapter -ServerAddresses ('8.8.8.8', '8.8.4.4') }
    $broken = $true
    Write-Log 'Vue sur le contrôleur de domaine coupée le temps de la sortie du domaine'
  }
  try {
    $r = Get-CimInstance -ClassName Win32_ComputerSystem | Invoke-CimMethod -MethodName 'UnjoinDomainOrWorkGroup' `
      -Arguments @{ FUnjoinOptions = [uint32]0; Username = "$env:COMPUTERNAME\$User"; Password = $Password }
    if ($r.ReturnValue -ne 0) { throw "UnjoinDomainOrWorkGroup a renvoyé le code $($r.ReturnValue)" }
  } finally {
    if ($broken) {
      if ($dns.Count -gt 0) { Safe 'dnsRetabli' { Set-DnsClientServerAddress -InterfaceAlias $adapter -ServerAddresses $dns } }
      else { Safe 'dnsReinit' { Set-DnsClientServerAddress -InterfaceAlias $adapter -ResetServerAddresses } }
      Write-Log 'DNS d''origine rétablis'
    }
  }
}

function Install-OuihelpPackage([string]$Path) {
  # Une stratégie peut interdire l'ajout de paquets de provisionnement (correctif V9 9.1)
  Set-RegValue 'HKLM:\SOFTWARE\Microsoft\PolicyManager\current\device\Security' 'AllowAddProvisioningPackage' 1
  $name = [IO.Path]::GetFileNameWithoutExtension($Path)
  # Nouvelle tentative après un échec : on retire d'abord NOTRE paquet déjà posé (et lui seul :
  # les paquets du constructeur restent en place).
  foreach ($p in @(Safe 'ppkgListe' { Get-ProvisioningPackage -AllInstalledPackages } @())) {
    if ($p.PackageName -eq $name) { Safe 'ppkgRetrait' { Remove-ProvisioningPackage -PackageId $p.PackageId } }
  }
  try {
    $null = Install-ProvisioningPackage -PackagePath $Path -ForceInstall -QuietInstall
  } catch {
    Write-Log "Install-ProvisioningPackage en échec ($($_.Exception.Message)) : nouvelle tentative avec DISM"
    $d = Start-Process -FilePath 'dism.exe' -ArgumentList "/Online /Add-ProvisioningPackage /PackagePath:`"$Path`"" -Wait -PassThru -NoNewWindow
    if ($d.ExitCode -ne 0) { throw "DISM /Add-ProvisioningPackage : code $($d.ExitCode)" }
  }
  Start-Sleep -Seconds 5
  $installed = @(Safe 'ppkgControle' { Get-ProvisioningPackage -AllInstalledPackages } @())
  if (@($installed | Where-Object { $_.PackageName -eq $name }).Count -eq 0) {
    throw 'PPKG installé mais absent de la liste des paquets du poste'
  }
}

$script:ProfileApiReady = $false
function Initialize-ProfileApi {
  if ($script:ProfileApiReady) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace DsiNative {
  public static class Profiles {
    [DllImport("userenv.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern int CreateProfile(string pszUserSid, string pszUserName, StringBuilder pszProfilePath, uint cchProfilePath);
  }
}
'@
  $script:ProfileApiReady = $true
}

# Retire des caches d'identité les entrées qui désignent encore le compte ONELA : sinon
# l'ancien UPN reste proposé sur l'écran de connexion et Windows mélange les deux comptes.
function Remove-IdentityCache([string]$OldUpn) {
  if (-not $OldUpn) { return }
  foreach ($root in @('HKLM:\SOFTWARE\Microsoft\IdentityStore\LogonCache', 'HKLM:\SOFTWARE\Microsoft\IdentityStore\Cache')) {
    foreach ($sub in @(Get-ChildItem $root -Recurse -ErrorAction SilentlyContinue)) {
      $p = Get-ItemProperty -LiteralPath $sub.PSPath -ErrorAction SilentlyContinue
      if (-not $p) { continue }
      $names = @($p.IdentityName, $p.UserName) | Where-Object { $_ }
      if ($names -contains $OldUpn) {
        Remove-Item -LiteralPath $sub.PSPath -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

# Suppression d'un profil ONELA qui n'est pas repris : Remove-CimInstance retire la clé
# ProfileList ET le dossier de C:\Users. Garde-fous : jamais un profil système, chargé, ou qui
# fait partie du transfert. Le compte ONELA ne pourrait de toute façon plus ouvrir de session.
function Remove-OldProfile($P, [string[]]$Keep) {
  if ($Keep -contains $P.sid) { return @{ ok = $false; message = 'profil repris, non supprimé' } }
  $prof = Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue | Where-Object { $_.SID -eq $P.sid }
  if (-not $prof) { return @{ ok = $true; message = 'déjà absent' } }
  if ($prof.Special) { return @{ ok = $false; message = 'profil système' } }
  if ($prof.Loaded) { return @{ ok = $false; message = 'profil chargé' } }
  $path = $prof.LocalPath
  try {
    Remove-CimInstance -InputObject $prof -ErrorAction Stop
  } catch {
    return @{ ok = $false; message = $_.Exception.Message }
  }
  # Reliquats éventuels : dossier verrouillé au moment de la suppression, clé laissée en place
  if ($path -and (Test-Path -LiteralPath $path)) {
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$($P.sid)" -Recurse -Force -ErrorAction SilentlyContinue
  Safe 'cacheIdentite' { Remove-IdentityCache $P.upn }
  $left = ($path -and (Test-Path -LiteralPath $path))
  if ($left) { return @{ ok = $true; message = "supprimé (dossier $path encore présent)" } }
  return @{ ok = $true; message = 'supprimé' }
}

# Transfert d'un profil Windows ONELA au compte Ouihelp (méthode V9) :
#  1. les jetons de l'ancien tenant (AAD.BrokerPlugin) sont retirés du profil ;
#  2. Windows enregistre le compte Ouihelp en créant son profil, aussitôt supprimé : seule
#     l'inscription compte, le dossier créé ne sert pas ;
#  3. ChangeOwner donne le profil ONELA existant au SID Ouihelp. Au prochain démarrage, le
#     nouveau compte retrouve bureau, documents et réglages de l'utilisateur.
function Convert-UserProfile($Map) {
  if (-not $Map.newSid -or -not $Map.newSam) { return @{ ok = $false; message = 'compte Ouihelp absent de l''ordre' } }
  if ($Map.oldSid -eq $Map.newSid) { return @{ ok = $true; message = 'même compte, rien à faire' } }
  $old = Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue | Where-Object { $_.SID -eq $Map.oldSid }
  if (-not $old) { return @{ ok = $false; message = 'profil absent du poste' } }
  if ($old.Loaded) { return @{ ok = $false; message = 'profil encore chargé' } }

  foreach ($b in @(Get-ChildItem (Join-Path $old.LocalPath 'AppData\Local\Packages') -Filter 'Microsoft.AAD.BrokerPlugin_*' -Directory -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $b.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }

  Initialize-ProfileApi
  $sb = New-Object Text.StringBuilder 260
  $created = [DsiNative.Profiles]::CreateProfile($Map.newSid, $Map.newSam, $sb, [uint32]$sb.Capacity)
  # 0 = créé ; -2147024713 (0x800700B7) = déjà présent
  if ($created -ne 0 -and $created -ne -2147024713) {
    return @{ ok = $false; message = "CreateProfile a renvoyé $created" }
  }
  $new = Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue | Where-Object { $_.SID -eq $Map.newSid }
  if ($new) { Remove-CimInstance -InputObject $new -ErrorAction SilentlyContinue }

  $old = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $Map.oldSid }
  $res = $old | Invoke-CimMethod -MethodName 'ChangeOwner' -Arguments @{ NewOwnerSID = $Map.newSid; Flags = [uint32]0 }
  if ($res.ReturnValue -ne 0) { return @{ ok = $false; message = "ChangeOwner a renvoyé le code $($res.ReturnValue)" } }
  Safe 'cacheIdentite' { Remove-IdentityCache $Map.oldUpn }
  return @{ ok = $true; message = 'transféré' }
}

# Préparation (phase « staging ») : rien de destructif. PPKG téléchargé et vérifié, ordre figé
# sur le poste (sans secret) pour que les phases suivantes survivent aux redémarrages.
function New-InplacePayload($Order) {
  if (-not (Test-Path $MigDir)) { $null = New-Item -ItemType Directory -Path $MigDir -Force }
  $null = Invoke-Api 'GET' '/migration/package' $null $InplacePpkg
  $hash = (Get-FileHash -Path $InplacePpkg -Algorithm SHA256).Hash.ToLower()
  if ($hash -ne $Order.packageSha256) {
    Remove-Item $InplacePpkg -Force -ErrorAction SilentlyContinue
    throw "PPKG altéré : empreinte $hash au lieu de $($Order.packageSha256)"
  }
  $state = [ordered]@{
    phase           = 'prepared'
    attempts        = 0
    lastError       = ''
    startedAt       = (Get-Date).ToString('o')
    computerName    = [string]$Order.computerName
    ouihelpTenantId = [string]$Order.ouihelpTenantId
    profileMap      = @(@($Order.profileMap) | ForEach-Object {
        [ordered]@{ oldSid = $_.oldSid; oldUpn = $_.oldUpn; newSid = $_.newSid; newUpn = $_.newUpn; newSam = $_.newSam }
      })
    removeProfiles  = @(@($Order.removeProfiles) | ForEach-Object {
        [ordered]@{ sid = $_.sid; account = $_.account; upn = $_.upn }
      })
  }
  Save-Inplace $state
  return $state
}

# Phase 1 - point de non-retour : le poste quitte ONELA et reçoit le PPKG Ouihelp.
function Start-InplaceSwitch($Order) {
  $state = Get-Inplace
  if (-not $state -or -not (Test-Path $InplacePpkg)) {
    Send-Progress 'bascule' 'error' 'Préparation absente du poste : bascule à reprogrammer' @{ fatal = $true }
    return
  }
  if (-not (Test-PhaseAttempt $state $SwitchAttempts)) {
    Clear-MigrationNotice
    $dsreg = Safe 'dsreg' { Get-DsregStatus }
    $ou = if ($dsreg -and $dsreg.azureAdJoined) { 'poste encore dans ONELA' } else { 'poste sorti d''ONELA et pas encore joint à Ouihelp' }
    Send-Progress 'bascule' 'error' "Bascule abandonnée après $SwitchAttempts tentatives ($ou) : $($state.lastError) - à reprendre sur place (compte de secours)" @{ fatal = $true }
    Remove-InplacePayload
    return
  }
  Send-Progress 'bascule' 'info' 'Bascule en place lancée : sortie d''ONELA puis PPKG Ouihelp' @{ resetTriggered = $true }
  Set-MigrationNotice 'Bascule vers Ouihelp en cours' `
    "Ce poste rejoint le tenant Ouihelp. Il redémarre deux fois tout seul : merci de ne pas l'éteindre. Ensuite, connectez-vous avec votre adresse et votre mot de passe Ouihelp."
  try {
    New-BreakglassAccount $Order.breakglassUser $Order.breakglassPassword
    Write-Log "Compte local de secours $($Order.breakglassUser) prêt"

    $remove = @($Order.removeApps)
    if ($remove.Count -gt 0) {
      $done = 0
      $failed = @()
      foreach ($name in $remove) {
        $r = Uninstall-AppByName $name
        if ($r.ok) { $done++ } else { $failed += "$name ($($r.message))" }
      }
      if ($failed.Count -eq 0) { Send-Progress 'applications' 'ok' "$done application(s) désinstallée(s)" }
      else { Send-Progress 'applications' 'error' "$done désinstallée(s) ; échec sur : $($failed -join ' ; ')" }
    }

    Remove-MdmEnrollment
    Send-Progress 'mdm' 'ok' 'Inscription Intune ONELA retirée du poste'

    $dsreg = Safe 'dsreg' { Get-DsregStatus }
    if ($dsreg -and $dsreg.azureAdJoined) {
      if (-not (Invoke-EntraLeave)) { throw 'Sortie d''Entra ONELA refusée (dsregcmd /leave)' }
      Send-Progress 'entra' 'ok' 'Poste sorti d''Entra ONELA'
    }
    if ((Get-CimInstance Win32_ComputerSystem).PartOfDomain) {
      Invoke-DomainUnjoin $Order.breakglassUser $Order.breakglassPassword
      Send-Progress 'domaine' 'ok' 'Poste sorti du domaine ONELA'
    }

    Install-OuihelpPackage $InplacePpkg
    Send-Progress 'ppkg' 'ok' 'PPKG Ouihelp installé : jonction au prochain démarrage'
  } catch {
    Write-Log "Bascule en place : $($_.Exception.Message)"
    $state.lastError = $_.Exception.Message
    Save-Inplace $state
    Send-Progress 'bascule' 'error' "Étape en échec : $($_.Exception.Message) - nouvelle tentative au prochain passage"
    return
  }
  $state.phase = 'profiles'
  $state.attempts = 0
  Save-Inplace $state
  Send-Progress 'redemarrage' 'info' 'Redémarrage pour le transfert des profils'
  & shutdown.exe /r /t 30 /c 'Bascule vers Ouihelp : redemarrage' | Out-Null
}

# Phase 2 - transfert des profils, session fermée (un profil chargé ne peut pas changer de
# propriétaire). Un profil en échec garde son ancien propriétaire : c'est rendu au serveur.
function Invoke-InplaceProfiles($State) {
  $user = Get-InteractiveUser
  if ($user) {
    Write-Log "Transfert des profils : session ouverte ($user), nouvel essai au prochain passage"
    return
  }
  if (-not (Test-PhaseAttempt $State $ProfileAttempts)) {
    Clear-MigrationNotice
    Send-Progress 'profils' 'error' "Transfert des profils abandonné après $ProfileAttempts tentatives : poste joint à Ouihelp, profils à reprendre à la main" @{ fatal = $true }
    Remove-InplacePayload
    return
  }
  $maps = @($State.profileMap | Where-Object { $_ -and $_.oldSid })
  $ok = @()
  $failed = @()
  if ($maps.Count -eq 0) {
    Send-Progress 'profils' 'info' 'Aucun profil à transférer : passage à la jonction'
    $ok += 'aucun'
  }
  foreach ($m in $maps) {
    $label = $m.oldUpn
    if (-not $label) { $label = $m.oldSid }
    $r = Convert-UserProfile $m
    if ($r.ok) { $ok += "$label → $($m.newUpn)" } else { $failed += "$label : $($r.message)" }
  }
  if ($ok.Count -eq 0) {
    Send-Progress 'profils' 'error' "Transfert en échec : $($failed -join ' ; ') - nouvelle tentative au prochain passage"
    return
  }
  if ($failed.Count -gt 0) {
    Send-Progress 'profils' 'error' "Transféré(s) : $($ok -join ', ') ; échec sur $($failed -join ' ; ')"
  } else {
    Send-Progress 'profils' 'ok' "Profil(s) transféré(s) : $($ok -join ', ')"
  }
  # Les autres profils ONELA ne sont supprimés qu'une fois le transfert réussi.
  # @($null) vaut un élément vide : on filtre (états écrits par une version antérieure)
  $remove = @($State.removeProfiles | Where-Object { $_ -and $_.sid })
  if ($remove.Count -gt 0) {
    $keep = @($State.profileMap | Where-Object { $_ } | ForEach-Object { $_.oldSid; $_.newSid })
    $gone = @()
    $kept = @()
    foreach ($rp in $remove) {
      $label = $rp.upn
      if (-not $label) { $label = $rp.account }
      if (-not $label) { $label = $rp.sid }
      $r = Remove-OldProfile $rp $keep
      if ($r.ok) { $gone += $label } else { $kept += "$label : $($r.message)" }
    }
    if ($kept.Count -eq 0) {
      Send-Progress 'profils-supprimes' 'ok' "$($gone.Count) profil(s) supprimé(s) du poste : $($gone -join ', ')"
    } else {
      Send-Progress 'profils-supprimes' 'error' "$($gone.Count) profil(s) supprimé(s) ; conservé(s) : $($kept -join ' ; ')"
    }
  }
  $State.phase = 'join'
  $State.attempts = 0
  Save-Inplace $State
  Send-Progress 'redemarrage' 'info' 'Redémarrage vers l''écran de connexion Ouihelp'
  & shutdown.exe /r /t 30 /c 'Bascule vers Ouihelp : redemarrage' | Out-Null
}

# Phase 3 - jonction Ouihelp constatée sur le poste : clé BitLocker séquestrée chez Ouihelp,
# nom DSI appliqué (après le PPKG, qui peut imposer le sien), compte rendu « joined » au
# serveur, qui termine côté tenants (suppression ONELA, Autopilot et utilisateur principal).
function Invoke-InplaceJoin($State) {
  $joined = $false
  $deadline = (Get-Date).AddMinutes(5)
  while ($true) {
    $s = Safe 'dsregJonction' { Get-DsregStatus }
    if ($s -and $s.azureAdJoined -and (-not $State.ouihelpTenantId -or $s.tenantId -eq $State.ouihelpTenantId)) {
      $joined = $true
      break
    }
    if ((Get-Date) -ge $deadline) { break }
    Start-Sleep -Seconds 20
  }
  if (-not $joined) {
    if (-not (Test-PhaseAttempt $State $JoinAttempts)) {
      Clear-MigrationNotice
      Send-Progress 'jonction' 'error' 'Poste sorti d''ONELA mais toujours pas joint à Ouihelp : PPKG à reprendre à la main (jeton en bloc expiré ?)' @{ fatal = $true }
      Remove-InplacePayload
      return
    }
    Send-Progress 'jonction' 'info' 'Jonction Ouihelp pas encore constatée : nouvelle tentative au prochain passage'
    return
  }

  Safe 'bitlocker' {
    $v = Get-BitLockerVolume -MountPoint $env:SystemDrive
    foreach ($kp in @($v.KeyProtector | Where-Object { $_.KeyProtectorType -eq 'RecoveryPassword' })) {
      $null = BackupToAAD-BitLockerKeyProtector -MountPoint $env:SystemDrive -KeyProtectorId $kp.KeyProtectorId
    }
  }
  $renamed = $false
  if ($State.computerName -and $env:COMPUTERNAME -ne $State.computerName) {
    try {
      Rename-Computer -NewName $State.computerName -Force -ErrorAction Stop
      $renamed = $true
      Write-Log "Renommé en $($State.computerName) (effectif au redémarrage)"
    } catch {
      Write-Log "Renommage en $($State.computerName) impossible : $($_.Exception.Message)"
    }
  }
  Clear-MigrationNotice
  Send-Progress 'jonction' 'ok' "Poste joint à Entra Ouihelp, nom $($State.computerName) ; l'utilisateur se connecte avec son compte Ouihelp" @{ joined = $true }
  Remove-InplacePayload
  Restore-Sleep
  if ($renamed) { & shutdown.exe /r /t 60 /c 'Bascule vers Ouihelp terminee : redemarrage' | Out-Null }
}

# Phases 2 et 3 : reprises à chaque passage de l'agent, même sans ordre côté serveur - le poste
# a déjà quitté ONELA, il doit aller au bout sous peine de rester entre les deux tenants.
function Resume-InplaceMigration {
  $state = Get-Inplace
  if (-not $state) { return }
  switch ($state.phase) {
    'profiles' { Invoke-InplaceProfiles $state }
    'join'     { Invoke-InplaceJoin $state }
  }
}

function Invoke-InplaceMigration($Order) {
  switch ($Order.status) {
    'cancelled' {
      if (Test-Path $MigDir) {
        Remove-InplacePayload
        Restore-Sleep
        Clear-MigrationNotice
        Send-Progress 'nettoyage' 'ok' 'Bascule annulée : fichiers retirés du poste (poste inchangé)'
      }
    }
    'staging' {
      # Dès la préparation, le PC ne doit plus s'endormir (session fermée = écran de verrouillage)
      Disable-Sleep
      if (-not (Test-MigrationConsent $Order)) { return }
      if (-not (Test-PowerOk)) { Send-Progress 'attente' 'info' 'Sur batterie sous 50 % : en attente du secteur'; return }
      if (@($Order.profileMap).Count -eq 0) {
        Send-Progress 'controle' 'error' 'Aucun profil à transférer dans l''ordre reçu' @{ fatal = $true }
        return
      }
      $free = Safe 'disque' { (Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$env:SystemDrive'").FreeSpace }
      if ($free -and $free -lt $InplaceFreeBytes) {
        Send-Progress 'controle' 'error' ("Espace disque insuffisant ({0:N1} Go libres, {1:N0} Go attendus) : poste inchangé" -f ($free / 1GB), ($InplaceFreeBytes / 1GB)) @{ fatal = $true }
        return
      }
      try {
        $state = New-InplacePayload $Order
      } catch {
        Remove-InplacePayload
        Send-Progress 'preparation' 'error' "Préparation impossible : $($_.Exception.Message)" @{ fatal = $true }
        return
      }
      Send-Progress 'preparation' 'ok' "Prêt : PPKG vérifié, $(@($state.profileMap).Count) profil(s) à transférer" `
        @{ staged = $true; hardwareHash = (Safe 'empreinte' { Get-HardwareHash }) }
      Wait-ForReady 'inplace' $Order
    }
    { $_ -in 'staged', 'cleanup' } { Disable-Sleep; Wait-ForReady 'inplace' $Order }
    'ready' {
      Disable-Sleep
      if (-not (Test-MigrationConsent $Order)) { return }
      Start-InplaceSwitch $Order
    }
    { $_ -in 'resetting', 'joining' } {
      # Bascule interrompue au milieu de la phase 1 (le serveur est déjà passé en « resetting »,
      # l'état local est resté « prepared ») : on la reprend là où elle s'est arrêtée.
      $state = Get-Inplace
      if ($state -and $state.phase -eq 'prepared') { Disable-Sleep; Start-InplaceSwitch $Order }
      else { Resume-InplaceMigration }
    }
  }
}

# ═════════════════════════════════════════════════════════════════════════════

function Invoke-ResetMigration($Order) {
  switch ($Order.status) {
    'cancelled' {
      if ((Test-Path $PayloadDir) -or (Test-Path $MigDir)) {
        Remove-MigrationPayload
        Restore-Sleep
        Send-Progress 'nettoyage' 'ok' 'Bascule annulée : fichiers retirés du poste'
      }
    }
    'staging' {
      # Dès la préparation, le PC ne doit plus s'endormir (session fermée = écran de verrouillage)
      Disable-Sleep
      if (-not (Test-MigrationConsent $Order)) { return }
      if (-not (Test-PowerOk)) { Send-Progress 'attente' 'info' 'Sur batterie sous 50 % : en attente du secteur'; return }
      if ((Get-WinreEnabled) -eq $false) { Send-Progress 'controle' 'error' 'WinRE désactivé : réinitialisation impossible' @{ fatal = $true }; return }
      try {
        $wifiCount = New-MigrationPayload $Order
        $hash = Get-HardwareHash
      } catch {
        Remove-MigrationPayload
        Send-Progress 'preparation' 'error' "Préparation impossible : $($_.Exception.Message)" @{ fatal = $true }
        return
      }
      Send-Progress 'preparation' 'ok' "Prêt : PPKG vérifié, $wifiCount Wi-Fi exporté(s), fichiers déposés dans C:\Recovery\OEM" @{ staged = $true; hardwareHash = $hash }
      Wait-ForReady 'reset'
    }
    { $_ -in 'staged', 'cleanup' } { Disable-Sleep; Wait-ForReady 'reset' }
    'ready' { Disable-Sleep; Start-Reset }
  }
}

function Invoke-Migration($Order) {
  try {
    if ($Order.mode -eq 'inplace') { Invoke-InplaceMigration $Order } else { Invoke-ResetMigration $Order }
  } catch {
    Write-Log "Bascule : erreur inattendue $($_.Exception.Message)"
  }
}

# Sondage léger de bascule : appelé à chaque réveil de la tâche (toutes les 2 min) pour réagir
# vite à une programmation, sans envoyer le rapport d'inventaire complet (qui reste espacé).
# Ne fait rien tant que l'agent n'est pas enrôlé (pas de jeton).
function Invoke-MigrationPoll {
  if (-not (Test-Path $TokenPath)) { return }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $order = Safe 'migrationPoll' { Invoke-Api 'GET' '/order' }
  if ($order -and $order.migration) {
    $null = Invoke-Migration $order.migration
    return
  }
  $inplace = Get-Inplace
  if ($inplace -and @('profiles', 'join') -contains $inplace.phase) {
    # Bascule en place déjà engagée (poste sorti d'ONELA) : on termine le travail local même
    # si la DSI a abandonné la bascule côté serveur.
    Write-Log "Bascule en place sans ordre côté serveur : poursuite locale (phase $($inplace.phase))"
    Resume-InplaceMigration
    return
  }
  if ($inplace -or (Test-Path $PayloadDir)) {
    # Plus de bascule active (échec / annulation) et rien d'engagé sur le poste : on retire les
    # fichiers déposés (PPKG, clés Wi-Fi, ResetConfig) et les réglages de bascule.
    Remove-MigrationPayload
    Remove-InplacePayload
    Restore-Sleep
    Clear-MigrationNotice
    Write-Log 'Bascule terminée côté serveur : fichiers de bascule retirés du poste'
  }
}

# ═════════════════════════════════════════════════════════════════════════════

try {
  if ($Uninstall) { Uninstall-Agent; exit 0 }
  if ($PSCommandPath -ne $InstalledPs) { Install-Agent; exit 0 }
  # D'abord la bascule (réactif), puis le rapport d'inventaire (espacé par nextCheckinAt)
  Invoke-MigrationPoll
  # Code de sortie ≠ 0 en cas d'échec : visible dans « Dernier résultat » de la tâche planifiée
  if (Invoke-Checkin) { exit 1 }
  exit 0
} catch {
  Write-Log "Erreur fatale : $($_.Exception.Message)"
  Write-Error $_
  exit 1
}
