#Requires -Version 5.1
<#
.SYNOPSIS
  Vérifie DsiAgent.ps1 avant livraison (Intune / GPO).

.DESCRIPTION
  Windows PowerShell 5.1 lit un .ps1 sans BOM en ANSI (Windows-1252) : un caractère comme
  « — » y contient l'octet 0x94, lu comme un guillemet fermant, et casse le script entier
  (cas de l'agent 1.0.4). On vérifie :
   1. la présence du BOM UTF-8 ;
   2. l'absence d'erreur de syntaxe en UTF-8 ;
   3. l'absence d'erreur de syntaxe si le fichier est lu en ANSI (BOM perdu en route).
  Utilisable sous Windows PowerShell 5.1 comme sous PowerShell 7 (macOS / Linux).

.EXAMPLE
  pwsh tools/device-agent/Test-AgentScript.ps1
  pwsh tools/device-agent/Test-AgentScript.ps1 ~/Desktop/DsiAgent-onela.ps1
#>
param([string]$Path = (Join-Path $PSScriptRoot 'DsiAgent.ps1'))

$bytes = [IO.File]::ReadAllBytes((Resolve-Path $Path))
$ok = $true

if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
  Write-Host 'OK     BOM UTF-8 présent'
} else {
  Write-Host 'ÉCHEC  BOM UTF-8 absent : PowerShell 5.1 lira le fichier en ANSI'
  $ok = $false
}

if ($PSVersionTable.PSEdition -eq 'Core') {
  [Text.Encoding]::RegisterProvider([Text.CodePagesEncodingProvider]::Instance)
}
$readings = [ordered]@{
  'UTF-8'                  = (New-Object Text.UTF8Encoding($false)).GetString($bytes).TrimStart([char]0xFEFF)
  'ANSI (BOM perdu)'       = [Text.Encoding]::GetEncoding(1252).GetString($bytes)
}
foreach ($name in $readings.Keys) {
  $tokens = $null; $errors = $null
  [Management.Automation.Language.Parser]::ParseInput($readings[$name], [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors) {
    $ok = $false
    Write-Host "ÉCHEC  syntaxe en lecture $name :"
    $errors | Select-Object -First 3 | ForEach-Object { Write-Host "         ligne $($_.Extent.StartLineNumber) : $($_.Message)" }
  } else {
    Write-Host "OK     syntaxe en lecture $name"
  }
}

# Les tirets Unicode U+2011 à U+2014 (tiret insécable, tiret demi-cadratin, cadratin)
# s'écrivent en UTF-8 avec un 3ᵉ octet
# 0x91 à 0x94 : lus en ANSI, ce sont les guillemets courbes « ' » et « " », que PowerShell
# accepte comme délimiteurs de chaîne. Un nombre impair avalait alors tout le reste du script
# (la syntaxe ne cassait que par chance, quand ils allaient par deux).
$dashes = @()
$lines = $readings['UTF-8'] -split "`n"
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '[\u2011-\u2014]') { $dashes += ($i + 1) }
}
if ($dashes.Count -gt 0) {
  $ok = $false
  Write-Host "ÉCHEC  tiret Unicode (U+2011 à U+2014) ligne(s) $($dashes -join ', ') : remplacer par un tiret simple"
} else {
  Write-Host 'OK     aucun tiret Unicode'
}

if ($ok) { Write-Host 'Script prêt à être déployé.'; exit 0 }
exit 1
