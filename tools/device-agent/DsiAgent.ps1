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

  Hors bascule, LECTURE SEULE : l'agent ne modifie rien sur le poste. Il n'exécute jamais de
  commande reçue du serveur : la seule action possible est la bascule codée ci-dessous
  (réinstallation propre vers Ouihelp), déclenchée uniquement si la DSI a programmé CE poste.

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

$AgentVersion = '1.1.4'
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
  # Toutes les 15 min : la cadence réelle vient du serveur (4 h, 15 min pendant une bascule)
  $every30 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 15)
  $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
  Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action -Trigger @($atStartup, $every30) `
    -Principal $principal -Settings $settings -Description 'Agent DSI ONELA — inventaire avant migration Ouihelp (lecture seule)' -Force | Out-Null

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
    # Ordre de bascule (lot 3) ; $null = : aucune sortie ne doit polluer le retour de la fonction
    if ($res.migration) {
      $null = Invoke-Migration $res.migration
    }
    elseif (Test-Path $PayloadDir) {
      # Plus de bascule active (échec ou annulation côté serveur) mais des fichiers subsistent
      # dans C:\Recovery\OEM (PPKG, clés Wi-Fi en clair, ResetConfig) : on les retire.
      Remove-MigrationPayload
      Restore-Sleep
      Write-Log 'Bascule terminée côté serveur : fichiers de bascule retirés de C:\Recovery\OEM'
    }
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

function Invoke-Api([string]$Method, [string]$Path, $Body = $null, [string]$OutFile = $null) {
  $headers = @{ Authorization = 'Bearer ' + (Get-Content $TokenPath -Raw).Trim() }
  $uri = "$($ApiUrl.TrimEnd('/'))/api/device-agent$Path"
  if ($OutFile) { return Invoke-WebRequest -Method $Method -Uri $uri -Headers $headers -OutFile $OutFile -TimeoutSec 120 -UseBasicParsing }
  if ($null -ne $Body) {
    $json = $Body | ConvertTo-Json -Depth 4 -Compress
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes($json)) `
      -ContentType 'application/json; charset=utf-8' -TimeoutSec 60 -UseBasicParsing
  }
  return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -TimeoutSec 60 -UseBasicParsing
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
  Remove-Item $PromptScript, $PromptChoice -Force -ErrorAction SilentlyContinue
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
# Fichiers d'échange avec la session utilisateur : dans C:\Users\Public, seul endroit où un
# utilisateur standard peut écrire (C:\ProgramData\DSI est réservé à SYSTEM/Administrateurs).
$PromptScript = Join-Path $env:PUBLIC 'dsi-maj-pc.ps1'
$PromptChoice = Join-Path $env:PUBLIC 'dsi-maj-choix.txt'
$PromptSnoozeUntil = Join-Path $MigDir 'snooze-until'

# Affiche à l'utilisateur connecté, dans SA session, une fenêtre « Démarrer / Plus tard ».
# Lancée depuis SYSTEM via une tâche planifiée à jeton interactif (pas de mot de passe stocké).
function Show-MigrationPrompt([string]$User, $Order) {
  $allowSnooze = if ($Order.snoozeCount -lt $Order.maxSnoozes) { '$true' } else { '$false' }
  $later = [int]$Order.snoozeMinutes
  $dialog = @"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
`$choice = '$PromptChoice'
`$msg = @'
$($Order.promptMessage)
'@
`$f = New-Object System.Windows.Forms.Form
`$f.Text = 'Mise a jour de votre PC - DSI'
`$f.Size = New-Object System.Drawing.Size(520, 240)
`$f.StartPosition = 'CenterScreen'
`$f.TopMost = `$true
`$f.FormBorderStyle = 'FixedDialog'
`$f.MaximizeBox = `$false; `$f.MinimizeBox = `$false
`$l = New-Object System.Windows.Forms.Label
`$l.Text = `$msg
`$l.Size = New-Object System.Drawing.Size(480, 120)
`$l.Location = New-Object System.Drawing.Point(20, 20)
`$l.Font = New-Object System.Drawing.Font('Segoe UI', 11)
`$f.Controls.Add(`$l)
`$go = New-Object System.Windows.Forms.Button
`$go.Text = 'Demarrer maintenant'
`$go.Size = New-Object System.Drawing.Size(180, 36)
`$go.Location = New-Object System.Drawing.Point(300, 150)
`$go.Add_Click({ Set-Content -Path `$choice -Value 'start' -Encoding ASCII; `$f.Close() })
`$f.Controls.Add(`$go)
if ($allowSnooze) {
  `$later = New-Object System.Windows.Forms.Button
  `$later.Text = 'Plus tard ($later min)'
  `$later.Size = New-Object System.Drawing.Size(150, 36)
  `$later.Location = New-Object System.Drawing.Point(140, 150)
  `$later.Add_Click({ Set-Content -Path `$choice -Value 'snooze' -Encoding ASCII; `$f.Close() })
  `$f.Controls.Add(`$later)
}
[System.Windows.Forms.Application]::Run(`$f)
"@
  Set-Content -Path $PromptScript -Value $dialog -Encoding UTF8
  Remove-Item $PromptChoice -Force -ErrorAction SilentlyContinue
  try {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PromptScript`""
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName 'DSI\Avertissement migration' -Action $action -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName 'DSI\Avertissement migration'
    Write-Log "Avertissement affiché à $User"
  } catch {
    Write-Log "Affichage de l'avertissement impossible : $($_.Exception.Message)"
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

# Attend que le serveur ait retiré le PC d'Autopilot ONELA (8 min max par passage : la tâche
# planifiée est limitée à 15 min, mesure des profils comprise).
function Wait-ForReady {
  $deadline = (Get-Date).AddMinutes(8)
  while ((Get-Date) -lt $deadline) {
    $s = Safe 'migrationStatus' { Invoke-Api 'GET' '/migration' }
    switch ($s.status) {
      'ready'     { Start-Reset; return }
      'failed'    { Write-Log "Bascule en échec côté serveur : $($s.error)"; Remove-MigrationPayload; return }
      'cancelled' { Remove-MigrationPayload; return }
    }
    Start-Sleep -Seconds 20
  }
  Write-Log 'Retrait Autopilot ONELA pas encore confirmé : nouvel essai au prochain passage'
}

function Invoke-Migration($Order) {
  try {
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
        $user = Get-InteractiveUser
        if ($user) {
          if (-not $Order.promptUser) {
            Send-Progress 'attente' 'info' "Session ouverte ($user) : la préparation attend qu'elle soit fermée"; return
          }
          # Mode « session ouverte » : on prévient l'utilisateur et on attend son accord
          $choice = if (Test-Path $PromptChoice) { (Get-Content $PromptChoice -Raw -ErrorAction SilentlyContinue).Trim() } else { $null }
          if ($choice -eq 'start') {
            Remove-Item $PromptChoice -Force -ErrorAction SilentlyContinue
            if (-not (Test-Path $MigDir)) { $null = New-Item -ItemType Directory -Path $MigDir -Force }
            Set-Content -Path $ConsentMarker -Value (Get-Date).ToString('o') -Encoding ASCII
            Send-Progress 'accord' 'ok' "$user a cliqué « Démarrer » : préparation en cours"
            # on poursuit la préparation ci-dessous
          }
          elseif ($choice -eq 'snooze') {
            Remove-Item $PromptChoice -Force -ErrorAction SilentlyContinue
            Set-Content -Path $PromptSnoozeUntil -Value (Get-Date).AddMinutes($Order.snoozeMinutes).ToString('o') -Encoding ASCII
            Send-Progress 'report' 'info' "Mise à jour reportée par $user" @{ snoozed = $true }
            return
          }
          else {
            # Pas encore de réponse : on (ré)affiche l'avertissement, sauf pendant un report en cours
            $until = if (Test-Path $PromptSnoozeUntil) { try { [datetime](Get-Content $PromptSnoozeUntil -Raw) } catch { [datetime]::MinValue } } else { [datetime]::MinValue }
            if ((Get-Date) -ge $until) {
              Show-MigrationPrompt $user $Order
              Send-Progress 'avertissement' 'info' "Avertissement affiché à $user (en attente de son accord)"
            }
            return
          }
        }
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
        Wait-ForReady
      }
      { $_ -in 'staged', 'cleanup' } { Disable-Sleep; Wait-ForReady }
      'ready' { Disable-Sleep; Start-Reset }
    }
  } catch {
    Write-Log "Bascule : erreur inattendue $($_.Exception.Message)"
  }
}

# ═════════════════════════════════════════════════════════════════════════════

try {
  if ($Uninstall) { Uninstall-Agent; exit 0 }
  if ($PSCommandPath -ne $InstalledPs) { Install-Agent; exit 0 }
  # Code de sortie ≠ 0 en cas d'échec : visible dans « Dernier résultat » de la tâche planifiée
  if (Invoke-Checkin) { exit 1 }
  exit 0
} catch {
  Write-Log "Erreur fatale : $($_.Exception.Message)"
  Write-Error $_
  exit 1
}
