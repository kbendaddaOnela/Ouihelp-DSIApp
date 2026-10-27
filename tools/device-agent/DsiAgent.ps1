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

# Relance, avec les mêmes options, dans deux cas :
#  - fichier lu sans son BOM UTF-8 (copié par le Bloc-notes, un presse-papiers, un mail…) :
#    Windows PowerShell 5.1 le lit en ANSI et tous les accents sortent en « Ã© » dans les
#    fenêtres et le journal. On le réécrit avec son BOM (à défaut, une copie dans TEMP) ;
#  - PowerShell 32 bits (console « Windows PowerShell (x86) », script Intune sans l'option
#    64 bits) : HKLM\SOFTWARE redirigé vers WOW6432Node, plus de MachineGuid (rapport refusé,
#    400) ni de Get-LocalUser, dsregcmd introuvable. On passe au PowerShell 64 bits (Sysnative).
$self = $PSCommandPath
$exe = (Get-Process -Id $PID).Path
$relaunchNeeded = $false
if ('é'.Length -ne 1 -and $self) {
  $bytes = [IO.File]::ReadAllBytes($self)
  if (-not ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)) {
    $text = [Text.Encoding]::UTF8.GetString($bytes)
    $utf8Bom = New-Object Text.UTF8Encoding $true
    try { [IO.File]::WriteAllText($self, $text, $utf8Bom) }
    catch {
      $self = Join-Path $env:TEMP 'DsiAgent-bom.ps1'
      [IO.File]::WriteAllText($self, $text, $utf8Bom)
    }
    $relaunchNeeded = $true
  }
}
if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
  $ps64 = Join-Path $env:WINDIR 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'
  if (Test-Path $ps64) { $exe = $ps64; $relaunchNeeded = $true }
}
if ($relaunchNeeded) {
  $relaunch = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $self)
  if ($Uninstall) { $relaunch += '-Uninstall' }
  if ($Force) { $relaunch += '-Force' }
  & $exe @relaunch
  exit $LASTEXITCODE
}

# ── Configuration (à renseigner avant déploiement) ───────────────────────────
$ApiUrl        = 'https://REMPLACER.azurewebsites.net'   # URL de l'API DSI App, sans /api
$EnrollmentKey = 'REMPLACER'                             # = DEVICE_AGENT_ENROLLMENT_KEY côté API
# ─────────────────────────────────────────────────────────────────────────────

$AgentVersion = '1.2.18'
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

# Poste supprimé de la DSI App : la DSI ne veut plus de remontée, l'agent se retire (tâche
# planifiée, C:\ProgramData\DSI et C:\ProgramData\DSI-Ui). Jamais pendant une bascule en
# place déjà engagée : le poste est sorti d'ONELA, l'agent doit finir le travail.
function Invoke-RemoteUninstall {
  $inplace = Get-Inplace
  if ($inplace -and @('profiles', 'join') -contains $inplace.phase) {
    Write-Log "Désinstallation demandée par la DSI App ignorée : bascule en place engagée (phase $($inplace.phase))"
    return
  }
  Write-Log 'Poste supprimé de la DSI App : désinstallation de l''agent'
  Safe 'uninstallCleanup' {
    Remove-MigrationPayload
    Remove-InplacePayload
    Restore-Sleep
    Clear-MigrationNotice
    Restore-LogonUi
    Remove-AdDnsRule
  }
  if (Test-Path $PromptDir) { Remove-Item $PromptDir -Recurse -Force -ErrorAction SilentlyContinue }
  Uninstall-Agent
  exit 0
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
      # Compte AD supprimé ou poste sorti du domaine (après la bascule) : SID intraduisible,
      # cas attendu, pas journalisé (on retombe sur le nom du dossier de profil)
      try { $account = (New-Object Security.Principal.SecurityIdentifier $sid).Translate([Security.Principal.NTAccount]).Value }
      catch [Security.Principal.IdentityNotMappedException] { }
      catch { Write-Log "[ntName] $($_.Exception.Message)" }
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

# Sépare « "C:\chemin\outil.exe" arguments » (ou sans guillemets) en fichier + arguments.
function Split-CommandLine([string]$Line) {
  if ($Line -match '^\s*"([^"]+)"\s*(.*)$') { return [ordered]@{ file = $Matches[1]; arguments = $Matches[2].Trim() } }
  if ($Line -match '^\s*(.+?\.exe)\s*(.*)$') { return [ordered]@{ file = $Matches[1]; arguments = $Matches[2].Trim() } }
  return $null
}

# Désinstallation silencieuse d'une application, dans l'ordre :
#  1. produit MSI (clé {GUID}, ou UninstallString « MsiExec /I|/X {GUID} ») : msiexec /x /qn ;
#  2. QuietUninstallString fournie par l'éditeur ;
#  3. UninstallString d'un installeur connu, complétée de ses options silencieuses :
#     Microsoft 365 / OneNote Click-to-Run (DisplayLevel=False), Inno Setup (unins000.exe),
#     Citrix Workspace (TrolleyExpress /silent), McAfee WebAdvisor (/s).
# Renvoie $null sinon (installeur interactif : à désinstaller à la main).
function Get-AppUninstall($Key) {
  $id = Split-Path $Key.PSPath -Leaf
  $uninstall = [string]$Key.UninstallString
  if ($Key.WindowsInstaller -eq 1 -and $id -match '^\{[0-9A-Fa-f-]{36}\}$') {
    return [ordered]@{ file = 'msiexec.exe'; arguments = "/x $id /qn /norestart" }
  }
  if ($uninstall -match 'msiexec(\.exe)?"?\s+/[IX]\s*(\{[0-9A-Fa-f-]{36}\})') {
    return [ordered]@{ file = 'msiexec.exe'; arguments = "/x $($Matches[2]) /qn /norestart" }
  }
  $quiet = [string]$Key.QuietUninstallString
  if ($quiet) {
    $cmd = Split-CommandLine $quiet
    if ($cmd) { return $cmd }
    return [ordered]@{ file = 'cmd.exe'; arguments = "/c $quiet" }
  }
  $cmd = if ($uninstall) { Split-CommandLine $uninstall } else { $null }
  if (-not $cmd) { return $null }
  $exe = Split-Path $cmd.file -Leaf
  if ($exe -eq 'OfficeClickToRun.exe') {
    if ($cmd.arguments -notmatch 'DisplayLevel=') { $cmd.arguments += ' DisplayLevel=False' }
    if ($cmd.arguments -notmatch 'forceappshutdown=') { $cmd.arguments += ' forceappshutdown=True' }
    return $cmd
  }
  if ($exe -match '^unins\d{3}\.exe$') {
    $cmd.arguments = ($cmd.arguments + ' /VERYSILENT /SUPPRESSMSGBOXES /NORESTART').Trim()
    return $cmd
  }
  if ($exe -eq 'TrolleyExpress.exe') {
    if ($cmd.arguments -notmatch '/silent') { $cmd.arguments += ' /silent' }
    return $cmd
  }
  if ($exe -eq 'Uninstaller.exe' -and $cmd.file -match '\\McAfee\\WebAdvisor\\') {
    $cmd.arguments = ($cmd.arguments + ' /s').Trim()
    return $cmd
  }
  return $null
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
    $startArgs = @{ FilePath = $cmd.file; PassThru = $true; WindowStyle = 'Hidden' }
    if ($cmd.arguments) { $startArgs.ArgumentList = $cmd.arguments }
    $p = Start-Process @startArgs
    $null = $p.Handle   # sans lui, ExitCode reste vide après WaitForExit(délai)
    # Un désinstalleur qui attend un clic (fenêtre invisible en SYSTEM) bloquerait la bascule :
    # 10 min au plus, puis abandon de cette application
    if (-not $p.WaitForExit(600000)) {
      try { $p.Kill() } catch { }
      return @{ ok = $false; message = 'sans réponse après 10 min (désinstalleur interactif ?)' }
    }
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
    antivirus    = Safe 'antivirus' { Get-Antivirus } @()
  }
}

# Antivirus inscrits auprès du Centre de sécurité Windows. Un antivirus tiers (Avast, McAfee…)
# peut mettre l'agent en quarantaine ou bloquer la bascule : la DSI App le signale.
# productState : l'octet 0x00F000 vaut 1 quand la protection en temps réel est active.
function Get-Antivirus {
  $list = Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop
  return ,@($list | ForEach-Object {
    [ordered]@{ name = [string]$_.displayName; enabled = ((([int]$_.productState) -shr 12) -band 0xF) -eq 1 }
  })
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
    if ($res.uninstall) { Invoke-RemoteUninstall }
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
      # Corps de la réponse : le serveur y explique la cause (ex. rapport refusé et pourquoi)
      $detail = $null
      if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        $detail = $_.ErrorDetails.Message
        try { $m = ($detail | ConvertFrom-Json).message; if ($m) { $detail = $m } } catch { }
      }
      $failure = "Réponse HTTP $status de $ApiUrl : $(if ($detail) { $detail } else { $_.Exception.Message })"
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
# powercfg sans jamais bloquer la bascule. Sous Windows PowerShell 5.1 avec
# $ErrorActionPreference = 'Stop', un message sur stderr redirigé (2>$null) devient une
# exception : c'est le cas quand une GPO impose les réglages d'alimentation (« Il existe des
# paramètres de remplacement de stratégie de groupe… »), et la bascule s'arrêtait là à
# chaque passage. Renvoie $true si powercfg a accepté le réglage.
function Invoke-PowerCfg([string[]]$Arguments) {
  $ErrorActionPreference = 'Continue'
  try {
    $null = & powercfg.exe @Arguments 2>&1
    return $LASTEXITCODE -eq 0
  } catch { return $false }
}

function Disable-Sleep {
  $refused = 0
  foreach ($c in @(
    'standby-timeout-ac 0', 'standby-timeout-dc 0',
    'hibernate-timeout-ac 0', 'hibernate-timeout-dc 0',
    'monitor-timeout-ac 0', 'monitor-timeout-dc 0',
    'disk-timeout-ac 0', 'disk-timeout-dc 0'
  )) {
    if (-not (Invoke-PowerCfg (@('/change') + $c.Split(' ')))) { $refused++ }
  }
  # Fermeture du capot = « ne rien faire » sur secteur et sur batterie (indices 0/1)
  foreach ($pa in @('SUB_BUTTONS LIDACTION')) {
    $sub, $setting = $pa.Split(' ')
    if (-not (Invoke-PowerCfg @('/setacvalueindex', 'SCHEME_CURRENT', $sub, $setting, '0'))) { $refused++ }
    if (-not (Invoke-PowerCfg @('/setdcvalueindex', 'SCHEME_CURRENT', $sub, $setting, '0'))) { $refused++ }
  }
  $null = Invoke-PowerCfg @('/setactive', 'SCHEME_CURRENT')
  if ($refused) {
    Write-Log "Veille : $refused réglage(s) d'alimentation refusé(s) (imposés par GPO), bascule poursuivie"
  } else {
    Write-Log 'Veille / extinction écran / action capot neutralisées pour la bascule'
  }
}

function Restore-Sleep {
  # Rétablit les délais par défaut du profil équilibré (après une annulation)
  $null = Invoke-PowerCfg @('/restoredefaultschemes')
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
# Étape en cours, lue chaque seconde par la fenêtre de progression (lignes clé=valeur)
$PromptProgress = Join-Path $PromptDir 'progress.txt'
# Logos affichés dans le bandeau des fenêtres (PNG en base64, écrits à côté du .exe)
$LogoOnelaB64 = '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'
$LogoOuihelpB64 = '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'
$PromptScript = Join-Path $env:PUBLIC 'dsi-maj-pc.ps1'   # ancienne fenêtre (≤ 1.1.6), supprimée au nettoyage
$PromptChoice = Join-Path $env:PUBLIC 'dsi-maj-choix.txt'
$PromptSnoozeUntil = Join-Path $MigDir 'snooze-until'

$PromptSource = @'
using System;
using System.IO;
using System.Text;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Windows.Forms;

// Fenêtres affichées à l'utilisateur pendant la bascule vers Ouihelp (compilées sur le poste).
//   prompt <fichier de choix> <fichier de progression> <durée du report> <reports restants>
//   progress <fichier de progression>
// Après « Démarrer », la même fenêtre enchaîne sur la progression : l'utilisateur voit tout de
// suite que quelque chose se passe, avant même le passage suivant de l'agent.
public static class DsiUi {
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  public static readonly Color Navy = Color.FromArgb(0, 41, 82);
  public static readonly Color Green = Color.FromArgb(64, 208, 150);
  public static readonly Color Text2 = Color.FromArgb(90, 96, 104);
  public static readonly Color Muted = Color.FromArgb(150, 155, 162);
  public static readonly Color Line = Color.FromArgb(226, 229, 233);
  public static readonly Color Amber = Color.FromArgb(160, 98, 10);

  public static Image Logo(string name) {
    try {
      string p = Path.Combine(Application.StartupPath, name);
      return File.Exists(p) ? Image.FromFile(p) : null;
    } catch { return null; }
  }

  public static Label MakeLabel(string text, float size, FontStyle style, Color color, int x, int y, int w, int h) {
    Label l = new Label();
    l.Text = text;
    l.Font = new Font("Segoe UI", size, style);
    l.ForeColor = color;
    l.BackColor = Color.Transparent;
    l.SetBounds(x, y, w, h);
    return l;
  }

  public static Button MakeButton(string text, bool primary, int x, int y, int w, int h) {
    Button b = new Button();
    b.Text = text;
    b.FlatStyle = FlatStyle.Flat;
    b.Font = new Font("Segoe UI", 10f, primary ? FontStyle.Bold : FontStyle.Regular);
    b.SetBounds(x, y, w, h);
    b.Cursor = Cursors.Hand;
    if (primary) {
      b.BackColor = Navy; b.ForeColor = Color.White;
      b.FlatAppearance.BorderSize = 0;
      b.FlatAppearance.MouseOverBackColor = Color.FromArgb(20, 70, 120);
    } else {
      b.BackColor = Color.White; b.ForeColor = Navy;
      b.FlatAppearance.BorderColor = Color.FromArgb(200, 205, 212);
      b.FlatAppearance.MouseOverBackColor = Color.FromArgb(244, 246, 248);
    }
    return b;
  }

  public static void Prepare(Form f, int w, int h, string title) {
    f.AutoScaleDimensions = new SizeF(96f, 96f);
    f.AutoScaleMode = AutoScaleMode.Dpi;
    f.Text = title;
    f.ClientSize = new Size(w, h);
    f.StartPosition = FormStartPosition.CenterScreen;
    f.TopMost = true;
    f.FormBorderStyle = FormBorderStyle.FixedSingle;
    f.ControlBox = false;
    f.BackColor = Color.White;
    f.Font = new Font("Segoe UI", 9.75f);
    f.ShowInTaskbar = true;
  }

  [STAThread]
  public static int Main(string[] a) {
    // Net sur les écrans à 125-150 % (sinon Windows étire une image floue)
    try { SetProcessDPIAware(); } catch { }
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    if (a.Length >= 2 && a[0] == "progress") {
      Application.Run(new ProgressForm(a[1]));
      return 0;
    }
    if (a.Length < 5) return 2;
    int snooze = 15, remaining = 0;
    int.TryParse(a[3], out snooze);
    int.TryParse(a[4], out remaining);
    PromptForm pf = new PromptForm(snooze, remaining);
    Application.Run(pf);
    if (pf.Choice != null) {
      try { File.WriteAllText(a[1], pf.Choice); } catch { }
    }
    if (pf.Choice == "start") Application.Run(new ProgressForm(a[2]));
    return 0;
  }
}

// Bandeau : logo ONELA, flèche animée, logo Ouihelp. Fondu de l'un vers l'autre selon Progress.
public class BrandBar : Control {
  Image onela = DsiUi.Logo("onela.png");
  Image ouihelp = DsiUi.Logo("ouihelp.png");
  Timer timer = new Timer();
  int phase;
  public float Progress = -1f; // -1 : les deux logos pleins (avertissement)

  public BrandBar() {
    SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
    BackColor = Color.FromArgb(246, 248, 250);
    timer.Interval = 60;
    timer.Tick += delegate { phase = (phase + 1) % 1000; Invalidate(); };
    timer.Start();
  }

  void DrawLogo(Graphics g, Image img, RectangleF box, float alpha) {
    if (img == null) return;
    float scale = Math.Min(box.Width / img.Width, box.Height / img.Height);
    float w = img.Width * scale, h = img.Height * scale;
    RectangleF r = new RectangleF(box.X + (box.Width - w) / 2, box.Y + (box.Height - h) / 2, w, h);
    ColorMatrix cm = new ColorMatrix();
    cm.Matrix33 = Math.Max(0f, Math.Min(1f, alpha));
    using (ImageAttributes ia = new ImageAttributes()) {
      ia.SetColorMatrix(cm);
      g.DrawImage(img, Rectangle.Round(r), 0, 0, img.Width, img.Height, GraphicsUnit.Pixel, ia);
    }
  }

  protected override void OnPaint(PaintEventArgs e) {
    Graphics g = e.Graphics;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
    float W = ClientSize.Width, H = ClientSize.Height;
    float p = Progress;
    float aOnela = p < 0 ? 1f : 1f - 0.7f * p;
    float aOuihelp = p < 0 ? 1f : 0.3f + 0.7f * p;
    DrawLogo(g, onela, new RectangleF(W * 0.06f, H * 0.18f, W * 0.30f, H * 0.64f), aOnela);
    DrawLogo(g, ouihelp, new RectangleF(W * 0.62f, H * 0.30f, W * 0.32f, H * 0.40f), aOuihelp);
    // Trois chevrons dont la couleur avance de gauche à droite (vague)
    float cx = W * 0.49f, cy = H / 2f, step = H * 0.16f, size = H * 0.11f;
    for (int i = 0; i < 3; i++) {
      double wave = Math.Sin((phase * 0.18) - i * 1.1);
      int alpha = (int)(90 + 165 * (wave + 1) / 2);
      float x = cx + (i - 1) * step;
      using (Pen pen = new Pen(Color.FromArgb(alpha, DsiUi.Green), Math.Max(2f, H * 0.035f))) {
        pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round;
        g.DrawLines(pen, new PointF[] { new PointF(x - size / 2, cy - size), new PointF(x + size / 2, cy), new PointF(x - size / 2, cy + size) });
      }
    }
    using (Pen line = new Pen(DsiUi.Line)) g.DrawLine(line, 0, H - 1, W, H - 1);
  }

  protected override void Dispose(bool disposing) { if (disposing) timer.Dispose(); base.Dispose(disposing); }
}

public class PromptForm : Form {
  public string Choice;

  public PromptForm(int snooze, int remaining) {
    SuspendLayout();
    DsiUi.Prepare(this, 540, 360, "Mise à jour de votre PC \u2014 DSI");
    BrandBar bar = new BrandBar();
    bar.SetBounds(0, 0, 540, 86);
    Controls.Add(bar);

    Controls.Add(DsiUi.MakeLabel("Votre PC passe chez Ouihelp", 15f, FontStyle.Bold, DsiUi.Navy, 28, 104, 484, 32));
    Controls.Add(DsiUi.MakeLabel("La DSI met à jour votre ordinateur. Enregistrez votre travail et fermez vos applications avant de démarrer.", 10f, FontStyle.Regular, DsiUi.Text2, 28, 138, 484, 42));

    string[] icons = { "", "", "" };
    string[] lines = {
      "Environ 15 minutes, 2 redémarrages automatiques",
      "Vos fichiers et votre bureau sont conservés",
      "Ensuite : connectez-vous avec votre adresse et votre mot de passe Ouihelp"
    };
    for (int i = 0; i < 3; i++) {
      Label ic = DsiUi.MakeLabel(icons[i], 11f, FontStyle.Regular, DsiUi.Navy, 30, 190 + i * 26, 24, 24);
      ic.Font = new Font("Segoe MDL2 Assets", 11f);
      Controls.Add(ic);
      Controls.Add(DsiUi.MakeLabel(lines[i], 9.75f, FontStyle.Regular, DsiUi.Text2, 58, 191 + i * 26, 460, 24));
    }

    Panel sep = new Panel();
    sep.BackColor = DsiUi.Line;
    sep.SetBounds(0, 286, 540, 1);
    Controls.Add(sep);

    string left = remaining > 0
      ? "Encore " + remaining + " report" + (remaining > 1 ? "s" : "") + " possible" + (remaining > 1 ? "s" : "")
      : "Plus de report possible";
    Controls.Add(DsiUi.MakeLabel(left, 9f, FontStyle.Regular, DsiUi.Muted, 28, 310, 170, 22));

    Button go = DsiUi.MakeButton("Démarrer maintenant", true, 336, 302, 176, 38);
    go.Click += delegate { Choice = "start"; Close(); };
    Controls.Add(go);
    AcceptButton = go;
    if (remaining > 0) {
      Button later = DsiUi.MakeButton("Plus tard (" + snooze + " min)", false, 186, 302, 140, 38);
      later.Click += delegate { Choice = "snooze"; Close(); };
      Controls.Add(later);
    }
    Shown += delegate { Activate(); };
    ResumeLayout(false);
  }
}

public class ProgressForm : Form {
  static readonly string[] Keys = { "prep", "apps", "onela", "ouihelp", "reboot" };
  static readonly string[] Labels = {
    "Préparation du PC",
    "Désinstallation des anciennes applications",
    "Retrait de l'environnement ONELA",
    "Installation de l'environnement Ouihelp",
    "Redémarrage"
  };
  readonly string file;
  string current = "prep", skip = "", note = "";
  DateTime rebootAt = DateTime.MinValue;
  bool allowClose;
  int spin;
  float shown;
  BrandBar bar;
  Panel steps, track;
  Label status, pct, noteLabel;
  Timer anim = new Timer(), poll = new Timer();

  public ProgressForm(string progressFile) {
    file = progressFile;
    SuspendLayout();
    DsiUi.Prepare(this, 540, 470, "Mise à jour en cours \u2014 DSI");
    bar = new BrandBar();
    bar.Progress = 0f;
    bar.SetBounds(0, 0, 540, 86);
    Controls.Add(bar);
    Controls.Add(DsiUi.MakeLabel("Mise à jour en cours", 15f, FontStyle.Bold, DsiUi.Navy, 28, 104, 484, 32));
    Controls.Add(DsiUi.MakeLabel("N'éteignez pas votre PC : il redémarre tout seul.", 10f, FontStyle.Regular, DsiUi.Text2, 28, 138, 484, 24));

    steps = new BufferedPanel();
    steps.SetBounds(28, 174, 484, 190);
    steps.Paint += PaintSteps;
    Controls.Add(steps);

    track = new BufferedPanel();
    track.SetBounds(28, 380, 484, 8);
    track.Paint += PaintTrack;
    Controls.Add(track);

    status = DsiUi.MakeLabel("", 9f, FontStyle.Regular, DsiUi.Muted, 28, 394, 400, 22);
    pct = DsiUi.MakeLabel("0 %", 9f, FontStyle.Regular, DsiUi.Muted, 432, 394, 80, 22);
    pct.TextAlign = ContentAlignment.TopRight;
    noteLabel = DsiUi.MakeLabel("", 9f, FontStyle.Regular, DsiUi.Amber, 28, 422, 484, 40);
    Controls.Add(status); Controls.Add(pct); Controls.Add(noteLabel);

    FormClosing += delegate(object s, FormClosingEventArgs e) { if (!allowClose && e.CloseReason == CloseReason.UserClosing) e.Cancel = true; };
    anim.Interval = 50;
    anim.Tick += delegate { spin = (spin + 14) % 360; Tick(); };
    poll.Interval = 1000;
    poll.Tick += delegate { Read(); };
    Shown += delegate { Activate(); Read(); anim.Start(); poll.Start(); };
    ResumeLayout(false);
  }

  void Read() {
    try {
      if (!File.Exists(file)) return;
      string[] lines = File.ReadAllLines(file, Encoding.UTF8);
      string n = "";
      foreach (string raw in lines) {
        int i = raw.IndexOf('=');
        if (i < 0) continue;
        string k = raw.Substring(0, i).Trim(), v = raw.Substring(i + 1).Trim();
        if (k == "step") current = v;
        else if (k == "skip") skip = v;
        else if (k == "note") n = v;
        else if (k == "reboot") { DateTime t; if (DateTime.TryParse(v, null, System.Globalization.DateTimeStyles.RoundtripKind, out t)) rebootAt = t.ToLocalTime(); }
        else if (k == "close" && v == "1") { allowClose = true; Close(); return; }
      }
      note = n;
    } catch { }
  }

  bool Skipped(string key) { return ("," + skip + ",").Contains("," + key + ","); }

  float Target() {
    int n = 0, idx = 0;
    for (int i = 0; i < Keys.Length; i++) {
      if (Skipped(Keys[i])) continue;
      if (Keys[i] == current) idx = n;
      n++;
    }
    if (current == "reboot" && rebootAt != DateTime.MinValue) {
      double left = (rebootAt - DateTime.Now).TotalSeconds;
      float frac = (float)Math.Max(0, Math.Min(1, 1 - left / 30.0));
      return (idx + frac) / n;
    }
    return (idx + 0.5f) / n;
  }

  void Tick() {
    float t = Target();
    shown += (t - shown) * 0.08f;
    bar.Progress = shown;
    pct.Text = (int)Math.Round(shown * 100) + " %";
    int ci = Array.IndexOf(Keys, current);
    string label = ci >= 0 ? Labels[ci] : "";
    if (current == "reboot" && rebootAt != DateTime.MinValue) {
      int left = (int)Math.Ceiling((rebootAt - DateTime.Now).TotalSeconds);
      label = left > 0 ? "Redémarrage dans " + left + " s" : "Redémarrage…";
    } else label += "…";
    status.Text = label;
    noteLabel.Text = note;
    steps.Invalidate();
    track.Invalidate();
  }

  void PaintSteps(object sender, PaintEventArgs e) {
    Graphics g = e.Graphics;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
    int ci = Array.IndexOf(Keys, current);
    float rowH = steps.ClientSize.Height / 5f;
    float d = rowH * 0.58f;
    int row = 0;
    using (Font f = new Font("Segoe UI", 10f))
    using (Font fb = new Font("Segoe UI", 10f, FontStyle.Bold)) {
      for (int i = 0; i < Keys.Length; i++) {
        if (Skipped(Keys[i])) continue;
        float y = row * rowH + (rowH - d) / 2;
        RectangleF c = new RectangleF(2, y, d, d);
        bool done = i < ci, cur = i == ci;
        if (done) {
          using (Brush b = new SolidBrush(DsiUi.Green)) g.FillEllipse(b, c);
          using (Pen p = new Pen(Color.White, d * 0.12f)) {
            p.StartCap = LineCap.Round; p.EndCap = LineCap.Round;
            g.DrawLines(p, new PointF[] { new PointF(c.X + d * 0.28f, c.Y + d * 0.52f), new PointF(c.X + d * 0.44f, c.Y + d * 0.68f), new PointF(c.X + d * 0.74f, c.Y + d * 0.36f) });
          }
        } else if (cur) {
          using (Pen ring = new Pen(DsiUi.Line, d * 0.12f)) g.DrawEllipse(ring, c);
          using (Pen arc = new Pen(DsiUi.Navy, d * 0.12f)) { arc.StartCap = LineCap.Round; arc.EndCap = LineCap.Round; g.DrawArc(arc, c, spin, 100); }
        } else {
          using (Pen ring = new Pen(Color.FromArgb(205, 209, 215), d * 0.08f)) g.DrawEllipse(ring, c);
        }
        Color tc = done ? DsiUi.Text2 : cur ? DsiUi.Navy : DsiUi.Muted;
        using (Brush tb = new SolidBrush(tc)) {
          SizeF sz = g.MeasureString(Labels[i], cur ? fb : f);
          g.DrawString(Labels[i], cur ? fb : f, tb, d + 14, row * rowH + (rowH - sz.Height) / 2);
        }
        row++;
      }
    }
  }

  void PaintTrack(object sender, PaintEventArgs e) {
    Graphics g = e.Graphics;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    Rectangle r = track.ClientRectangle;
    using (Brush b = new SolidBrush(DsiUi.Line)) g.FillRectangle(b, r);
    int w = (int)(r.Width * Math.Max(0, Math.Min(1, shown)));
    if (w > 0) using (Brush b = new SolidBrush(DsiUi.Green)) g.FillRectangle(b, 0, 0, w, r.Height);
  }
}

public class BufferedPanel : Panel {
  public BufferedPanel() {
    SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
    BackColor = Color.White;
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
  [IO.File]::WriteAllBytes((Join-Path $PromptDir 'onela.png'), [Convert]::FromBase64String($LogoOnelaB64))
  [IO.File]::WriteAllBytes((Join-Path $PromptDir 'ouihelp.png'), [Convert]::FromBase64String($LogoOuihelpB64))
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
    return 'OK'
  } catch {
    return "erreur $($_.Exception.Message)"
  }
}

# Résultat de la dernière exécution de la tâche d'avertissement, pour le journal.
function Get-PromptTaskResult {
  $info = Safe 'tacheAvertissement' { Get-ScheduledTaskInfo -TaskPath $PromptTaskPath -TaskName $PromptTaskName }
  if (-not $info) { return 'tâche absente' }
  return ('résultat 0x{0:X}' -f ([int64]$info.LastTaskResult -band 4294967295))
}

# Attend que la fenêtre soit réellement là. Un seul contrôle 5 s après le lancement était
# trompeur : sur un poste qui vient d'être réinstallé, le premier démarrage de l'exe (WinForms,
# compilé sur place) prend plus longtemps - l'agent déclarait un échec alors que l'utilisateur
# avait la fenêtre devant lui. Une réponse déjà donnée compte aussi comme un succès.
function Wait-PromptWindow([int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ($true) {
    if (Get-Process -Name 'DsiMajPc' -ErrorAction SilentlyContinue) { return $true }
    if (Test-Path $PromptChoice) { return $true }
    if ((Get-Date) -ge $deadline) { return $false }
    Start-Sleep -Seconds 2
  }
}

# Affiche à l'utilisateur connecté, dans SA session, une fenêtre « Démarrer / Plus tard ».
# Renvoie 'shown' (lancée et toujours ouverte), 'open' (déjà affichée) ou 'failed'.
function Show-MigrationPrompt([string]$User, $Order) {
  try {
    if (Get-Process -Name 'DsiMajPc' -ErrorAction SilentlyContinue) { return 'open' }
    Initialize-PromptExe
    Remove-Item $PromptChoice, $PromptScript, $PromptProgress -Force -ErrorAction SilentlyContinue
    # Textes dans le programme (plus d'accents abîmés par la lecture de l'API) ; seuls la durée
    # du report et le nombre de reports restants sont passés
    $remaining = [Math]::Max(0, [int]$Order.maxSnoozes - [int]$Order.snoozeCount)
    $promptArgs = "prompt `"$PromptChoice`" `"$PromptProgress`" $([int]$Order.snoozeMinutes) $remaining"
    $cmd = "`"$PromptExe`" $promptArgs"
    Initialize-UserSessionLauncher
    $lines = [DsiNative.UserSession]::Launch($cmd)
    Write-Log "Avertissement ($User) : $($lines -join ' ; ')"
    # On ne se fie pas au compte rendu du lancement mais à la présence de la fenêtre.
    if (Wait-PromptWindow 20) { return 'shown' }
    # Secours : tâche planifiée au nom de l'utilisateur, lancée par le Planificateur lui-même
    # (donc hors du job de l'agent), dans sa session interactive.
    $viaTask = Start-PromptViaTask $User $PromptExe $promptArgs
    Write-Log "Avertissement ($User) par tâche planifiée : $viaTask"
    if ($viaTask -eq 'OK' -and (Wait-PromptWindow 40)) { return 'shown' }
    $script:PromptError = "$($lines -join ' ; ') ; tâche planifiée : $viaTask, $(Get-PromptTaskResult)"
    return 'failed'
  } catch {
    $script:PromptError = $_.Exception.Message
    Write-Log "Affichage de l'avertissement impossible : $($_.Exception.Message)"
    return 'failed'
  }
}

# Fenêtre de progression : l'agent écrit l'étape en cours, la fenêtre la relit chaque seconde.
# Étapes : prep, apps, onela, ouihelp, reboot (voir ProgressForm). « apps » est masquée quand il
# n'y a rien à désinstaller. Écriture atomique (fichier temporaire puis remplacement).
function Write-UiProgress([string]$Step, $Order = $null, [string]$Note = '', [datetime]$RebootAt = [datetime]::MinValue) {
  Safe 'uiProgress' {
    if (-not (Test-Path $PromptDir)) { return }
    $skip = if ($Order -and @($Order.removeApps | Where-Object { $_ }).Count -eq 0) { 'apps' } else { '' }
    $lines = @("step=$Step", "skip=$skip")
    if ($Note) { $lines += "note=$Note" }
    if ($RebootAt -ne [datetime]::MinValue) { $lines += 'reboot=' + $RebootAt.ToUniversalTime().ToString('o') }
    $tmp = "$PromptProgress.tmp"
    [IO.File]::WriteAllLines($tmp, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
    Move-Item -Path $tmp -Destination $PromptProgress -Force
  }
}

# Rouvre la fenêtre de progression si l'utilisateur est connecté et qu'elle n'est plus affichée
# (fermée par un plantage, ou accord donné dans une session précédente).
function Show-ProgressWindow {
  Safe 'progressWindow' {
    if (-not (Get-InteractiveUser)) { return }
    if (Get-Process -Name 'DsiMajPc' -ErrorAction SilentlyContinue) { return }
    Initialize-PromptExe
    Initialize-UserSessionLauncher
    $lines = [DsiNative.UserSession]::Launch("`"$PromptExe`" progress `"$PromptProgress`"")
    Write-Log "Fenêtre de progression : $($lines -join ' ; ')"
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
    Write-UiProgress 'prep' $Order
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
# Marge demandée avant la bascule. Le transfert de profil ne copie rien (changement de
# propriétaire) : c'est la place dont Windows aura besoin ensuite (stratégies et applications
# Intune Ouihelp, mises à jour, fichier d'échange).
$InplaceFreeBytes = 10GB
$CleanupMarker = Join-Path $MigDir 'cleanup-done'

function Get-FreeBytes {
  return Safe 'disque' { [long](Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$env:SystemDrive'").FreeSpace }
}

# Supprime le contenu d'un dossier (fichiers verrouillés ignorés). Renvoie les octets libérés.
function Clear-FolderContent([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return [long]0 }
  $before = [long](Safe "taille:$Path" { (Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum } 0)
  Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  $after = [long](Safe "taille:$Path" { (Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum } 0)
  return [Math]::Max([long]0, $before - $after)
}

# Nettoyage avant bascule, comme le script V9 : rien qui appartienne à l'utilisateur (ni
# Téléchargements, ni corbeille, ni C:\Temp). Renvoie un résumé de ce qui a été libéré.
function Invoke-DiskCleanup($Order) {
  $parts = @()
  # 1. Fichiers temporaires de Windows et de chaque profil
  $tmp = Clear-FolderContent (Join-Path $env:WINDIR 'Temp')
  foreach ($u in @(Get-ChildItem (Join-Path $env:SystemDrive 'Users') -Directory -Force -ErrorAction SilentlyContinue)) {
    $tmp += Clear-FolderContent (Join-Path $u.FullName 'AppData\Local\Temp')
  }
  $parts += ('temporaires {0:N1} Go' -f ($tmp / 1GB))
  # 2. Mises à jour Windows déjà installées (téléchargements) et cache d'optimisation de distribution
  $wu = [long]0
  Safe 'wuCache' {
    Stop-Service -Name 'wuauserv', 'bits' -Force -ErrorAction SilentlyContinue
    $script:wuFreed = Clear-FolderContent (Join-Path $env:WINDIR 'SoftwareDistribution\Download')
    Start-Service -Name 'bits', 'wuauserv' -ErrorAction SilentlyContinue
  }
  if ($script:wuFreed) { $wu = $script:wuFreed }
  Safe 'doCache' { Delete-DeliveryOptimizationCache -Force -ErrorAction SilentlyContinue }
  $parts += ('mises à jour {0:N1} Go' -f ($wu / 1GB))
  # 3. Profils que la DSI a déjà marqués à supprimer : ils l'auraient été après le transfert,
  #    on avance simplement leur suppression. Le profil conservé n'est jamais touché.
  $remove = @(@($Order.removeProfiles) | Where-Object { $_ -and $_.sid })
  if ($remove.Count -gt 0) {
    $keep = @(@($Order.profileMap) | Where-Object { $_ } | ForEach-Object { $_.oldSid; $_.newSid })
    $gone = 0
    foreach ($rp in $remove) {
      $r = Remove-OldProfile $rp $keep
      if ($r.ok) { $gone++ } else { Write-Log "Nettoyage : profil $($rp.sid) conservé ($($r.message))" }
    }
    $parts += "$gone profil(s) supprimé(s)"
  }
  return ($parts -join ', ')
}
$HelloKey = 'HKLM:\SOFTWARE\Policies\Microsoft\PassportForWork'

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

# Écran de connexion après la bascule : sans ça, Windows propose la vignette du dernier compte
# (le compte ONELA, qui ne peut plus se connecter) et l'utilisateur doit penser à cliquer
# « Autre utilisateur ». On efface le dernier utilisateur et on masque son nom jusqu'à la
# 1re connexion Ouihelp ; Restore-LogonUi rétablit ensuite le comportement normal.
$LogonUiKey    = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\LogonUI'
$LogonUiMarker = Join-Path $Root 'logonui-reset'

function Reset-LogonUi {
  Safe 'logonui' {
    # La valeur était-elle déjà imposée (GPO / Intune) ? Alors on ne la retirera pas après.
    $preset = $null -ne (Get-ItemProperty $PoliciesKey -Name 'DontDisplayLastUserName' -ErrorAction SilentlyContinue)
    Remove-ItemProperty -Path $LogonUiKey -Name 'LastLoggedOnUser', 'LastLoggedOnSAMUser', 'LastLoggedOnDisplayName', 'LastLoggedOnUserSID', 'SelectedUserSID', 'LastLoggedOnProvider' -ErrorAction SilentlyContinue
    if (-not $preset) {
      Set-RegValue $PoliciesKey 'DontDisplayLastUserName' 1
      Set-Content -Path $LogonUiMarker -Value (Get-Date).ToString('o') -Encoding ASCII
    }
  }
}

function Restore-LogonUi {
  if (-not (Test-Path $LogonUiMarker)) { return }
  $u = Get-InteractiveUser
  if (-not $u -or $u -match 'dsi-secours') { return }
  Safe 'logonuiRestore' {
    # Pendant cette 1re connexion, Windows n'a pas mémorisé le compte (dernier utilisateur
    # masqué) : sans ça, le redémarrage suivant proposait encore « Autre utilisateur »
    $sid = Safe 'logonuiSid' { (New-Object Security.Principal.NTAccount $u).Translate([Security.Principal.SecurityIdentifier]).Value }
    if ($sid) {
      Set-RegValue $LogonUiKey 'LastLoggedOnUser' $u 'String'
      Set-RegValue $LogonUiKey 'LastLoggedOnSAMUser' $u 'String'
      Set-RegValue $LogonUiKey 'LastLoggedOnUserSID' $sid 'String'
      Set-RegValue $LogonUiKey 'SelectedUserSID' $sid 'String'
      $cache = "HKLM:\SOFTWARE\Microsoft\IdentityStore\Cache\$sid\IdentityCache\$sid"
      $display = (Get-ItemProperty $cache -Name 'DisplayName' -ErrorAction SilentlyContinue).DisplayName
      if ($display) { Set-RegValue $LogonUiKey 'LastLoggedOnDisplayName' $display 'String' }
    }
    Remove-ItemProperty -Path $PoliciesKey -Name 'DontDisplayLastUserName' -ErrorAction SilentlyContinue
    Remove-Item $LogonUiMarker -Force -ErrorAction SilentlyContinue
    Write-Log "Écran de connexion rétabli après la 1re connexion de $u"
  }
}

# Page d'état de l'inscription côté utilisateur (ESP) : inutile ici (le poste est déjà prêt) et
# elle allonge la 1re connexion. Même réglage que le script V9 d'origine.
function Skip-UserEsp {
  Safe 'userEsp' {
    foreach ($k in @(Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Enrollments' -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Property -contains 'SkipUserStatusPage' })) {
      Set-ItemProperty -Path $k.PSPath -Name 'SkipUserStatusPage' -Value -1 -Type DWord
    }
  }
}

function Clear-MigrationNotice {
  Remove-ItemProperty -Path $PoliciesKey -Name 'legalnoticecaption', 'legalnoticetext' -ErrorAction SilentlyContinue
}

function Remove-InplacePayload {
  Get-Process -Name 'DsiMajPc' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item $PromptChoice, $PromptScript, $PromptProgress -Force -ErrorAction SilentlyContinue
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
  Hide-BreakglassAccount $User
}

# Compte de secours masqué sur l'écran de connexion (sa tuile poussait l'utilisateur vers
# « Autre utilisateur ») ; il reste utilisable en tapant .\dsi-secours. Appelé aussi à chaque
# passage pour les postes basculés avant l'agent 1.2.17.
$SpecialUsersKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
function Hide-BreakglassAccount([string]$User = 'dsi-secours') {
  Safe 'masqueSecours' {
    if (-not (Get-LocalUser -Name $User -ErrorAction SilentlyContinue)) { return }
    if ((Get-ItemProperty $SpecialUsersKey -Name $User -ErrorAction SilentlyContinue).$User -eq 0) { return }
    Set-RegValue $SpecialUsersKey $User 0
    Write-Log "Compte $User masqué sur l'écran de connexion"
  }
}

# Sortie de l'inscription MDM (Intune ONELA) : certificat d'appareil, clés d'inscription et
# tâches de synchronisation. Sans ça le poste continue d'essayer de parler à Intune ONELA.
# Client Configuration Manager (SCCM) ONELA : sans désinstallation, il continue de chercher le
# serveur ONELA et peut disputer à Intune Ouihelp les mises à jour et les applications.
# Désinstallation officielle (ccmsetup /uninstall), puis nettoyage manuel si le service reste,
# comme le script V9. Renvoie $null (pas de client), $true (retiré) ou $false (toujours là).
function Remove-SccmClient {
  if (-not (Get-Service -Name 'CcmExec' -ErrorAction SilentlyContinue)) { return $null }
  $setup = Join-Path $env:WINDIR 'ccmsetup\ccmsetup.exe'
  if (Test-Path $setup) {
    Safe 'ccmsetup' {
      $null = Start-Process -FilePath $setup -ArgumentList '/uninstall' -WindowStyle Hidden -PassThru
      # ccmsetup relance un processus en arrière-plan : on attend qu'il ait fini (10 min max)
      Start-Sleep -Seconds 10
      $deadline = (Get-Date).AddMinutes(10)
      while ((Get-Date) -lt $deadline -and (Get-Process -Name 'ccmsetup' -ErrorAction SilentlyContinue)) {
        Start-Sleep -Seconds 15
      }
    }
  }
  if (Get-Service -Name 'CcmExec' -ErrorAction SilentlyContinue) {
    Write-Log 'SCCM : client toujours présent après ccmsetup /uninstall, nettoyage manuel'
    foreach ($svc in 'CcmExec', 'smstsmgr', 'CmRcService', 'ccmsetup') {
      Safe "sccmService:$svc" {
        if (Get-Service -Name $svc -ErrorAction SilentlyContinue) {
          Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
          $null = & sc.exe delete $svc
        }
      }
    }
    foreach ($dir in 'CCM', 'ccmsetup', 'ccmcache') {
      Remove-Item (Join-Path $env:WINDIR $dir) -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item (Join-Path $env:WINDIR 'SMSCFG.ini') -Force -ErrorAction SilentlyContinue
    foreach ($key in 'HKLM:\SOFTWARE\Microsoft\CCM', 'HKLM:\SOFTWARE\Microsoft\CCMSetup', 'HKLM:\SOFTWARE\Microsoft\SMS') {
      Remove-Item $key -Recurse -Force -ErrorAction SilentlyContinue
    }
    Safe 'sccmWmi' {
      Get-CimInstance -Namespace 'root' -ClassName '__Namespace' -Filter "Name='ccm'" -ErrorAction SilentlyContinue |
        Remove-CimInstance -ErrorAction SilentlyContinue
    }
    Safe 'sccmCerts' { Get-ChildItem 'Cert:\LocalMachine\SMS' -ErrorAction SilentlyContinue | Remove-Item -Force }
  }
  return -not (Get-Service -Name 'CcmExec' -ErrorAction SilentlyContinue)
}

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
# PC du siège (nom ONL-…) encore joints à l'AD : les noms du domaine ONELA sont résolus par le
# DNS de l'AD (10.11.135.97), sans quoi le PC ne contacte pas son contrôleur de domaine (UPN
# des profils introuvables, relation d'approbation en échec). Règle NRPT limitée au domaine
# plutôt qu'un DNS fixe sur la carte : un portable garde les DNS de chaque réseau (DHCP) et le
# reste d'Internet n'en dépend pas. Retirée avant la sortie du domaine, à la jonction Ouihelp,
# à la désinstallation de l'agent, et dès que le poste n'est plus dans le domaine.
$SiegeAdDns = '10.11.135.97'
$AdDnsComment = 'DSI-AD-siege'

function Remove-AdDnsRule {
  Safe 'adDnsRetrait' {
    $rules = @(Get-DnsClientNrptRule -ErrorAction SilentlyContinue | Where-Object { $_.Comment -eq $AdDnsComment })
    if ($rules.Count -eq 0) { return }
    foreach ($r in $rules) { Remove-DnsClientNrptRule -Name $r.Name -Force }
    Clear-DnsClientCache
    Write-Log "DNS de l'AD ($SiegeAdDns) retiré"
  }
}

function Sync-AdDnsRule {
  # Bascule engagée : on n'y touche plus (la sortie du domaine la retire elle-même)
  if (Get-Inplace) { return }
  $cs = Get-CimInstance Win32_ComputerSystem
  if (-not ($cs.PartOfDomain -and $env:COMPUTERNAME -like 'ONL-*')) { Remove-AdDnsRule; return }
  $domain = [string]$cs.Domain
  Safe 'adDns' {
    $rules = @(Get-DnsClientNrptRule -ErrorAction SilentlyContinue | Where-Object { $_.Comment -eq $AdDnsComment })
    $ok = $rules.Count -eq 1 -and @($rules[0].NameServers) -contains $SiegeAdDns -and @($rules[0].Namespace) -contains ".$domain"
    if ($ok) { return }
    foreach ($r in $rules) { Remove-DnsClientNrptRule -Name $r.Name -Force }
    Add-DnsClientNrptRule -Namespace @(".$domain", $domain) -NameServers $SiegeAdDns -Comment $AdDnsComment
    Clear-DnsClientCache
    Write-Log "DNS de l'AD ($SiegeAdDns) ajouté pour le domaine $domain"
  }
}

function Invoke-DomainUnjoin([string]$User, [string]$Password) {
  # Sinon le contrôleur de domaine resterait joignable malgré la coupure des DNS ci-dessous
  Remove-AdDnsRule
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
  # Le nom du paquet est celui qu'a choisi l'assistant WCD (ex. IntuneDeviceMigrationV9), pas le
  # nom du fichier déposé par l'agent : on compare donc la liste avant et après, pas un nom.
  $before = @(Safe 'ppkgAvant' { Get-ProvisioningPackage -AllInstalledPackages } @() | ForEach-Object { $_.PackageId })
  try {
    $null = Install-ProvisioningPackage -PackagePath $Path -ForceInstall -QuietInstall
  } catch {
    Write-Log "Install-ProvisioningPackage en échec ($($_.Exception.Message)) : nouvelle tentative avec DISM"
    $d = Start-Process -FilePath 'dism.exe' -ArgumentList "/Online /Add-ProvisioningPackage /PackagePath:`"$Path`"" -Wait -PassThru -NoNewWindow
    if ($d.ExitCode -ne 0) { throw "DISM /Add-ProvisioningPackage : code $($d.ExitCode)" }
  }
  Start-Sleep -Seconds 5
  $after = @(Safe 'ppkgApres' { Get-ProvisioningPackage -AllInstalledPackages } @() | ForEach-Object { $_.PackageId })
  $added = @($after | Where-Object { $before -notcontains $_ })
  # La liste des paquets n'est pas toujours tenue à jour tout de suite, et une réinstallation
  # du même paquet n'y ajoute rien : on ne bloque pas là-dessus. La seule preuve qui compte est
  # la jonction au tenant Ouihelp, vérifiée par la phase « jonction » (dsregcmd).
  if ($added.Count -gt 0) { return "paquet $($added -join ', ') ajouté" }
  if ($after.Count -gt 0) { return "$($after.Count) paquet(s) installé(s) sur le poste" }
  return 'installation acceptée, liste des paquets vide (contrôle à la jonction)'
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
  # Client SCCM ONELA : dans un passage à part (jusqu'à 10 min, la tâche est limitée à 15),
  # une seule fois, sans compter parmi les tentatives de bascule. Non bloquant mais signalé.
  Show-ProgressWindow
  if (-not $state.sccmDone -and (Get-Service -Name 'CcmExec' -ErrorAction SilentlyContinue)) {
    Write-UiProgress 'onela' $Order
    Send-Progress 'sccm' 'info' 'Désinstallation du client SCCM (Configuration Manager) ONELA'
    $sccm = Remove-SccmClient
    if ($sccm -eq $false) { Send-Progress 'sccm' 'error' 'Client SCCM toujours présent après désinstallation : à retirer à la main' }
    else { Send-Progress 'sccm' 'ok' 'Client SCCM ONELA désinstallé' }
    $state | Add-Member -NotePropertyName sccmDone -NotePropertyValue $true -Force
    Save-Inplace $state
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
  $uiStep = 'prep'
  try {
    New-BreakglassAccount $Order.breakglassUser $Order.breakglassPassword
    Write-Log "Compte local de secours $($Order.breakglassUser) prêt"

    $remove = @($Order.removeApps)
    if ($remove.Count -gt 0) {
      $uiStep = 'apps'; Write-UiProgress $uiStep $Order
      $done = 0
      $failed = @()
      foreach ($name in $remove) {
        $r = Uninstall-AppByName $name
        if ($r.ok) { $done++ } else { $failed += "$name ($($r.message))" }
      }
      if ($failed.Count -eq 0) { Send-Progress 'applications' 'ok' "$done application(s) désinstallée(s)" }
      else { Send-Progress 'applications' 'error' "$done désinstallée(s) ; échec sur : $($failed -join ' ; ')" }
    }

    $uiStep = 'onela'; Write-UiProgress $uiStep $Order
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

    $uiStep = 'ouihelp'; Write-UiProgress $uiStep $Order
    $ppkgInfo = Install-OuihelpPackage $InplacePpkg
    Send-Progress 'ppkg' 'ok' "PPKG Ouihelp installé ($ppkgInfo) : jonction au prochain démarrage"
  } catch {
    Write-Log "Bascule en place : $($_.Exception.Message)"
    $state.lastError = $_.Exception.Message
    Save-Inplace $state
    Send-Progress 'bascule' 'error' "Étape en échec : $($_.Exception.Message) - nouvelle tentative au prochain passage"
    Write-UiProgress $uiStep $Order 'Une étape doit être relancée : la mise à jour reprend dans quelques minutes.'
    return
  }
  $state.phase = 'profiles'
  $state.attempts = 0
  Save-Inplace $state
  Send-Progress 'redemarrage' 'info' 'Redémarrage pour le transfert des profils'
  Write-UiProgress 'reboot' $Order '' (Get-Date).AddSeconds(30)
  Restart-AfterDelay 30
}

# Redémarrage sans la boîte Windows « Vous allez être déconnecté » : `shutdown /t 30` l'affiche
# par-dessus la fenêtre de progression, qui montre déjà son propre compte à rebours. L'agent
# attend lui-même puis redémarre aussitôt (/t 0 : pas de boîte ; /f comme le faisait /t 30).
function Restart-AfterDelay([int]$Seconds) {
  Start-Sleep -Seconds $Seconds
  & shutdown.exe /r /t 0 /f /d p:4:1 /c 'Bascule vers Ouihelp : redemarrage' | Out-Null
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
  # Nom DSI appliqué maintenant (le PPKG, déjà installé, a pu imposer le sien) : effectif au
  # redémarrage qui suit. Après la jonction, plus aucun redémarrage n'est imposé : il couperait
  # la 1re connexion Ouihelp de l'utilisateur (écran noir).
  if ($State.computerName -and $env:COMPUTERNAME -ne $State.computerName) {
    try {
      Rename-Computer -NewName $State.computerName -Force -ErrorAction Stop
      Write-Log "Renommé en $($State.computerName) (effectif au redémarrage)"
    } catch {
      Write-Log "Renommage en $($State.computerName) impossible : $($_.Exception.Message)"
    }
  }
  Skip-UserEsp
  Reset-LogonUi
  # Windows Hello : pas d'assistant de code PIN imposé à la 1re connexion Ouihelp (choix DSI).
  # Stratégie locale, appliquée avant la connexion ; à doubler d'un profil Intune Ouihelp.
  Safe 'hello' {
    Set-RegValue $HelloKey 'Enabled' 0
    Set-RegValue $HelloKey 'DisablePostLogonProvisioning' 1
  }
  $State.phase = 'join'
  $State.attempts = 0
  Save-Inplace $State
  Send-Progress 'redemarrage' 'info' 'Redémarrage vers l''écran de connexion Ouihelp'
  Restart-AfterDelay 30
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
  # Renommage normalement fait avant le redémarrage (phase des profils) : ici seulement en
  # secours, sans redémarrer (il prendra effet au prochain redémarrage normal du poste).
  $pendingName = ''
  if ($State.computerName -and $env:COMPUTERNAME -ne $State.computerName) {
    $current = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ComputerName' -ErrorAction SilentlyContinue).ComputerName
    if ($current -ne $State.computerName) {
      try {
        Rename-Computer -NewName $State.computerName -Force -ErrorAction Stop
        Write-Log "Renommé en $($State.computerName) (effectif au prochain redémarrage)"
      } catch {
        Write-Log "Renommage en $($State.computerName) impossible : $($_.Exception.Message)"
      }
    }
    $pendingName = ' (nom effectif au prochain redémarrage)'
  }
  Skip-UserEsp
  Clear-MigrationNotice
  Remove-AdDnsRule
  Send-Progress 'jonction' 'ok' "Poste joint à Entra Ouihelp, nom $($State.computerName)$pendingName ; l'utilisateur se connecte avec son compte Ouihelp" @{ joined = $true }
  Remove-InplacePayload
  Restore-Sleep
}

# Bascule relancée par la DSI alors que l'agent n'a plus son état local (abandon après plusieurs
# échecs, agent réinstallé) : on le reconstruit depuis l'ordre reçu et on déduit la phase de
# l'état réel du poste. Si le poste est encore dans ONELA, il n'y a rien à reprendre : la DSI
# doit reprogrammer une bascule complète (le PPKG doit être re-téléchargé).
function Restore-InplaceFromOrder($Order) {
  $dsreg = Safe 'dsreg' { Get-DsregStatus }
  $joinedOuihelp = $dsreg -and $dsreg.azureAdJoined -and $Order.ouihelpTenantId -and $dsreg.tenantId -eq $Order.ouihelpTenantId
  $joinedOnela = $dsreg -and $dsreg.azureAdJoined -and -not $joinedOuihelp
  $inDomain = [bool](Get-CimInstance Win32_ComputerSystem).PartOfDomain
  if ($joinedOnela -or $inDomain) {
    Send-Progress 'reprise' 'error' 'Poste encore rattaché à ONELA : reprogrammer une bascule complète plutôt que la reprendre' @{ fatal = $true }
    return $null
  }
  $phase = if ($joinedOuihelp) { 'join' } else { 'profiles' }
  $state = [ordered]@{
    phase           = $phase
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
  Send-Progress 'reprise' 'ok' "Bascule reprise sur le poste à l'étape « $phase »"
  return $state
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
      $free = Get-FreeBytes
      # Pas assez de place : un passage de nettoyage (fichiers temporaires, caches de mises à
      # jour, profils déjà marqués à supprimer), une seule fois, puis nouveau contrôle au passage
      # suivant (la tâche est limitée à 15 min).
      if ($free -and $free -lt $InplaceFreeBytes -and -not (Test-Path $CleanupMarker)) {
        Write-UiProgress 'prep' $Order
        Send-Progress 'nettoyage' 'info' ("Espace disque faible ({0:N1} Go libres) : nettoyage avant la bascule" -f ($free / 1GB))
        $report = Invoke-DiskCleanup $Order
        if (-not (Test-Path $MigDir)) { $null = New-Item -ItemType Directory -Path $MigDir -Force }
        Set-Content -Path $CleanupMarker -Value (Get-Date).ToString('o') -Encoding ASCII
        $after = Get-FreeBytes
        Send-Progress 'nettoyage' 'ok' ("{0:N1} Go libérés ({1}) : {2:N1} Go libres" -f (($after - $free) / 1GB), $report, ($after / 1GB))
        return
      }
      if ($free -and $free -lt $InplaceFreeBytes) {
        Send-Progress 'controle' 'error' ("Espace disque insuffisant même après nettoyage ({0:N1} Go libres, {1:N0} Go attendus) : libérer de la place sur le poste (Téléchargements, corbeille, vieux fichiers), puis reprogrammer. Poste inchangé" -f ($free / 1GB), ($InplaceFreeBytes / 1GB)) @{ fatal = $true }
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
      if (-not $state) { $state = Restore-InplaceFromOrder $Order }
      if (-not $state) { return }
      Disable-Sleep
      if ($state.phase -eq 'prepared') { Start-InplaceSwitch $Order }
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
  if ($order -and $order.uninstall) { Invoke-RemoteUninstall }
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
  Restore-LogonUi
  Hide-BreakglassAccount
  Sync-AdDnsRule
  # Code de sortie ≠ 0 en cas d'échec : visible dans « Dernier résultat » de la tâche planifiée
  if (Invoke-Checkin) { exit 1 }
  exit 0
} catch {
  Write-Log "Erreur fatale : $($_.Exception.Message)"
  Write-Error $_
  exit 1
}
