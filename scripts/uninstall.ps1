#requires -Version 5.1
<#
    uninstall.ps1  —  remove dsh-plugin-prompt-optimizer from the active DSH profile.

    Reverses install.ps1:
      1. <profile>\node_modules\dsh-plugin-prompt-optimizer   the junction
      2. <profile>\package.json -> dependencies               the link: row
      3. <profile>\package.json -> dsh.profile.bundles        the bundle row
      4. %DSH_HOME%\plugins\dsh-plugin-prompt-optimizer       the installed copy (-KeepFiles keeps it)

    The pristine backup in <profile>\.prompt-optimizer-snapshot\ is never deleted
    here; delete that folder by hand once you are happy.
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$KeepFiles,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$PackageName = 'dsh-plugin-prompt-optimizer'

function Step([string]$Text) { Write-Host ''; Write-Host $Text -ForegroundColor Cyan }
function Ok([string]$Text) { Write-Host ('[ ok ] ' + $Text) -ForegroundColor Green }
function Note([string]$Text) { Write-Host ('       ' + $Text) }
function Warn([string]$Text) { Write-Host ('[warn] ' + $Text) -ForegroundColor Yellow }
function Fail([string]$Text, [int]$Code = 1) {
    Write-Host ''
    Write-Host ('[FAIL] ' + $Text) -ForegroundColor Red
    exit $Code
}

function Write-JsonFile([string]$Path, [string]$Text) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

$roots = @()
if ($env:DSH_HOME) { $roots += $env:DSH_HOME }
$roots += 'E:\dsh'
if ($env:APPDATA) { $roots += (Join-Path $env:APPDATA 'dsh-desktop\harness') }
if ($env:LOCALAPPDATA) { $roots += (Join-Path $env:LOCALAPPDATA 'dsh-desktop\harness') }

$DshHome = $null
$ProfileDir = $null
foreach ($root in $roots) {
    if (-not $root) { continue }
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $candidate = Join-Path $root 'profiles\web'
    if (Test-Path -LiteralPath (Join-Path $candidate 'package.json')) {
        $DshHome = $root
        $ProfileDir = $candidate
        break
    }
}
if (-not $ProfileDir) {
    Fail ('no DSH web profile found. looked for: ' + (($roots | Where-Object { $_ }) -join ' | ')) 3
}

$PackageJson = Join-Path $ProfileDir 'package.json'
$NodeModules = Join-Path $ProfileDir 'node_modules'
$LinkPath = Join-Path $NodeModules $PackageName
$TargetDir = Join-Path (Join-Path $DshHome 'plugins') $PackageName
$SnapshotDir = Join-Path $ProfileDir '.prompt-optimizer-snapshot'

Step 'dsh-plugin-prompt-optimizer — uninstall'
Note ('profile : ' + $ProfileDir)
Note ('copy    : ' + $TargetDir)

$running = @()
foreach ($procName in @('DSH Desktop', 'dsh-desktop')) {
    $found = Get-Process -Name $procName -ErrorAction SilentlyContinue
    if ($found) { $running += $procName }
}
if ($running.Count -gt 0 -and -not $Force) {
    Write-Host ''
    Write-Host '[STOP] DSH Desktop is running.' -ForegroundColor Red
    Note ('process(es): ' + (($running | Select-Object -Unique) -join ', '))
    Note 'Quit it completely, then run this again.'
    exit 4
}

if ($DryRun) {
    Step 'plan (-DryRun: nothing was changed)'
    Note ('remove junction  ' + $LinkPath)
    Note ('remove dependency ' + $PackageName)
    Note ('remove bundle     ' + $PackageName)
    if (-not $KeepFiles) { Note ('remove files      ' + $TargetDir) }
    exit 0
}

# ----------------------------------------------------------- 1. package.json
$raw = [System.IO.File]::ReadAllText($PackageJson)
try {
    $config = $raw | ConvertFrom-Json
} catch {
    Fail ('the profile package.json does not parse: ' + $_.Exception.Message) 5
}

$changed = $false
if ($config.dependencies -and ($config.dependencies.PSObject.Properties.Name -contains $PackageName)) {
    $config.dependencies.PSObject.Properties.Remove($PackageName)
    $changed = $true
    Ok 'dependency row removed'
}
if ($config.dsh -and $config.dsh.profile -and $config.dsh.profile.bundles) {
    $bundles = @($config.dsh.profile.bundles)
    if ($bundles -contains $PackageName) {
        $config.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne $PackageName })
        $changed = $true
        Ok 'bundle row removed'
    }
}

if ($changed) {
    $newJson = $config | ConvertTo-Json -Depth 32
    try {
        $null = $newJson | ConvertFrom-Json
    } catch {
        Fail ('the edited package.json would not parse; nothing was written: ' + $_.Exception.Message) 7
    }
    Write-JsonFile $PackageJson $newJson
    Ok 'package.json rewritten'
} else {
    Note 'package.json already had no rows for this plugin'
}

# --------------------------------------------------------------- 2. junction
if (Test-Path -LiteralPath $LinkPath) {
    $item = Get-Item -LiteralPath $LinkPath -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        [System.IO.Directory]::Delete($LinkPath, $false)
    } else {
        Remove-Item -LiteralPath $LinkPath -Recurse -Force
    }
    Ok 'node_modules entry removed'
} else {
    Note 'no node_modules entry to remove'
}

# ------------------------------------------------------------------ 3. files
if ($KeepFiles) {
    Note ('files kept (because -KeepFiles): ' + $TargetDir)
} elseif (Test-Path -LiteralPath $TargetDir) {
    Remove-Item -LiteralPath $TargetDir -Recurse -Force
    Ok 'installed copy removed'
}

Write-Host ''
Write-Host 'UNINSTALL COMPLETED' -ForegroundColor Green
Write-Host '-------------------' -ForegroundColor Green
Note 'Start DSH Desktop again; the button is gone.'
Note ('backup still kept in: ' + $SnapshotDir + '  (safe to delete by hand)')
exit 0
