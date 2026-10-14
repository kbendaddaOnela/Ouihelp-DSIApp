#Requires -Version 5.1
<#
.SYNOPSIS
  Agent DSI — inventaire des PC ONELA avant leur bascule vers le tenant Ouihelp (lot 2).

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

  LECTURE SEULE : cet agent ne modifie rien sur le poste (ni jonction, ni session, ni
  profil). Il n'exécute aucune commande reçue du serveur.

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

$AgentVersion = '1.0.1'
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
  $every30 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 30)
  $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
  Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action -Trigger @($atStartup, $every30) `
    -Principal $principal -Settings $settings -Description 'Agent DSI ONELA — inventaire avant migration Ouihelp (lecture seule)' -Force | Out-Null

  # Nouvelle version : rapport immédiat sans attendre la cadence
  if (Test-Path $StatePath) { Remove-Item $StatePath -Force }
  Start-ScheduledTask -TaskName $TaskName
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
  foreach ($line in (& dsregcmd.exe /status 2>$null)) {
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
  $gpo = Safe 'gpoAutoEnroll' { (Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\MDM' -ErrorAction Stop).AutoEnrollMDM -eq 1 } $false
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

function Get-NetworkState {
  $ethernet = $false; $wifi = $false
  foreach ($a in (Safe 'netadapter' { Get-NetAdapter -Physical | Where-Object Status -eq 'Up' } @())) {
    if ($a.PhysicalMediaType -match '802\.11') { $wifi = $true }
    elseif ($a.PhysicalMediaType -match '802\.3') { $ethernet = $true }
  }
  # netsh écrit les SSID en UTF-8 : sans ça, PowerShell les décode avec la page de code
  # de la console (« Siège » devient « Si├¿ge »)
  $previousEncoding = [Console]::OutputEncoding
  try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
  $ssid = $null
  foreach ($line in (& netsh.exe wlan show interfaces 2>$null)) {
    if ($line -match '^\s*SSID\s*:\s*(.+?)\s*$') { $ssid = $Matches[1]; break }
  }
  # Libellés localisés (« All User Profile » / « Profil Tous les utilisateurs ») : on prend la valeur après « : »
  $profiles = @()
  foreach ($line in (& netsh.exe wlan show profiles 2>$null)) {
    if ($line -match '(?i)profil.*?:\s*(.+?)\s*$') { $profiles += $Matches[1] }
  }
  try { [Console]::OutputEncoding = $previousEncoding } catch { }
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
    $kind = 'unknown'; $account = $null
    if ($sid -like 'S-1-12-1-*') {
      $kind = 'entra'
      $account = Safe 'entraName' { (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\IdentityStore\Cache\$sid\IdentityCache\$sid" -ErrorAction Stop).UserName }
    } elseif ($sid -like 'S-1-5-21-*') {
      $kind = if ($localSid -and $sid.StartsWith("$localSid-")) { 'local' } else { 'ad' }
      $account = Safe 'ntName' { (New-Object Security.Principal.SecurityIdentifier $sid).Translate([Security.Principal.NTAccount]).Value }
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
      kind        = $kind
      lastUseTime = if ($p.LastUseTime) { $p.LastUseTime.ToUniversalTime().ToString('o') } else { $null }
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
  }
}

# ═════════════════════════════════════════════════════════════════════════════
# Check-in
# ═════════════════════════════════════════════════════════════════════════════

function Invoke-Checkin {
  $state = Get-State
  if (-not $Force -and $state.nextCheckinAt -and (Get-Date) -lt [datetime]$state.nextCheckinAt) { return }

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
  } catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status -eq 401 -and $hasToken) {
      # Jeton réinitialisé par la DSI : on se ré-enrôle au prochain passage
      Remove-Item $TokenPath -Force -ErrorAction SilentlyContinue
      $state.nextCheckinAt = $null
      Write-Log 'Jeton refusé (401) : supprimé, ré-enrôlement au prochain passage'
    } elseif ($status -eq 409) {
      $state.nextCheckinAt = (Get-Date).AddHours(24).ToString('o')
      Write-Log 'Poste déjà enregistré sans jeton local (409) : réinitialiser l''agent dans la DSI App'
    } else {
      Write-Log "Check-in en échec ($status) : $($_.Exception.Message)"
    }
  }
  Save-State $state
}

# ═════════════════════════════════════════════════════════════════════════════

try {
  if ($Uninstall) { Uninstall-Agent; exit 0 }
  if ($PSCommandPath -ne $InstalledPs) { Install-Agent; exit 0 }
  Invoke-Checkin
  exit 0
} catch {
  Write-Log "Erreur fatale : $($_.Exception.Message)"
  Write-Error $_
  exit 1
}
