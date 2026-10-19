#requires -Version 5.1
<#
    install.ps1  —  install dsh-plugin-prompt-optimizer into the active DSH profile.

    What it changes (nothing else is touched):
      1. %DSH_HOME%\plugins\dsh-plugin-prompt-optimizer   the installed copy
      2. <profile>\package.json -> dependencies           one "link:" entry
      3. <profile>\package.json -> dsh.profile.bundles    one bundle name
      4. <profile>\node_modules\dsh-plugin-prompt-optimizer   a junction to (1)

    Safety:
      * refuses to run while DSH Desktop is up (-Force overrides): this profile
        reloads live, and editing package.json under a running host is noisy
      * backs the pristine package.json up once, before the first mutation
      * validates the edited JSON by re-parsing it before anything is written
      * writes package.json as UTF-8 WITHOUT a BOM (a BOM breaks JSON.parse)
      * -DryRun prints the plan and changes nothing
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$PackageName = 'dsh-plugin-prompt-optimizer'
$PluginSource = Split-Path -Parent $PSScriptRoot

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

# --------------------------------------------------------------- 0. the source

if (-not (Test-Path -LiteralPath (Join-Path $PluginSource 'package.json'))) {
    Fail ('cannot find package.json beside ' + $PSScriptRoot) 2
}
if (-not (Test-Path -LiteralPath (Join-Path $PluginSource 'lib\client.js'))) {
    Fail 'the package is incomplete: lib\client.js is missing' 2
}

# --------------------------------------------------------- 1. find the profile

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
$LinkSpec = 'link:' + ($TargetDir -replace '\\', '/')

Step 'dsh-plugin-prompt-optimizer — install'
Note ('source  : ' + $PluginSource)
Note ('dsh home: ' + $DshHome)
Note ('profile : ' + $ProfileDir)
Note ('target  : ' + $TargetDir)

# ------------------------------------------------------- 2. running-host guard

$running = @()
foreach ($procName in @('DSH Desktop', 'dsh-desktop')) {
    $found = Get-Process -Name $procName -ErrorAction SilentlyContinue
    if ($found) { $running += $procName }
}
if ($running.Count -gt 0 -and -not $Force) {
    Write-Host ''
    Write-Host '[STOP] DSH Desktop is running.' -ForegroundColor Red
    Note ('process(es): ' + (($running | Select-Object -Unique) -join ', '))
    Note 'Quit DSH Desktop completely (including the tray), then run this again.'
    Note 'This profile uses patchReload = live; editing package.json under a'
    Note 'running host triggers a failing config reload.'
    exit 4
}
if ($running.Count -gt 0) {
    Warn 'DSH Desktop looks like it is running; continuing because -Force was given'
}

# --------------------------------------------------------------- 3. the input

$raw = [System.IO.File]::ReadAllText($PackageJson)
try {
    $config = $raw | ConvertFrom-Json
} catch {
    Fail ('the profile package.json does not parse: ' + $_.Exception.Message) 5
}
if (-not $config.dsh -or -not $config.dsh.profile) {
    Fail 'this profile package.json has no dsh.profile block; it is not a DSH profile' 5
}

$alreadyDependency = $false
if ($config.dependencies -and $config.dependencies.PSObject.Properties.Name -contains $PackageName) {
    $alreadyDependency = $true
}
$alreadyBundle = $false
$bundles = @()
if ($config.dsh.profile.bundles) { $bundles = @($config.dsh.profile.bundles) }
if ($bundles -contains $PackageName) { $alreadyBundle = $true }

if ($DryRun) {
    Step 'plan (-DryRun: nothing was changed)'
    Note ('copy      ' + $PluginSource + '  ->  ' + $TargetDir)
    Note ('dependency ' + $PackageName + ' = ' + $LinkSpec + '   [present: ' + $alreadyDependency + ']')
    Note ('bundle     ' + $PackageName + '    [present: ' + $alreadyBundle + ']')
    Note ('junction   ' + $LinkPath + '  ->  ' + $TargetDir)
    Note ('backup     ' + (Join-Path $SnapshotDir 'package.json.orig'))
    exit 0
}

# ------------------------------------------------------------- 4. snapshot once

if (-not (Test-Path -LiteralPath $SnapshotDir)) {
    New-Item -ItemType Directory -Path $SnapshotDir -Force | Out-Null
    Copy-Item -LiteralPath $PackageJson -Destination (Join-Path $SnapshotDir 'package.json.orig') -Force
    Ok ('pristine package.json backed up to ' + $SnapshotDir)
} else {
    Note ('an earlier backup already exists in ' + $SnapshotDir + ' (kept, not overwritten)')
}

# ----------------------------------------------------------------- 5. copy files

if (-not (Test-Path -LiteralPath $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
}
& robocopy $PluginSource $TargetDir /MIR /XD node_modules .git /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
$copyCode = $LASTEXITCODE
if ($copyCode -ge 8) {
    Fail ('copying the plugin failed (robocopy exit ' + $copyCode + ')') 6
}
if (-not (Test-Path -LiteralPath (Join-Path $TargetDir 'lib\client.js'))) {
    Fail 'the copy is incomplete: lib\client.js is missing in the target' 6
}
Ok ('plugin files copied to ' + $TargetDir)

# -------------------------------------------------- 6. patch the profile JSON

if (-not $config.dependencies) {
    $config | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue ([pscustomobject]@{}) -Force
}
$config.dependencies | Add-Member -NotePropertyName $PackageName -NotePropertyValue $LinkSpec -Force

if (-not $config.dsh.profile.bundles) {
    $config.dsh.profile | Add-Member -NotePropertyName 'bundles' -NotePropertyValue @() -Force
}
$bundleList = @($config.dsh.profile.bundles)
if ($bundleList -notcontains $PackageName) {
    $bundleList = $bundleList + $PackageName
}
$config.dsh.profile.bundles = $bundleList

$newJson = $config | ConvertTo-Json -Depth 32
try {
    $check = $newJson | ConvertFrom-Json
} catch {
    Fail ('the edited package.json would not parse; nothing was written: ' + $_.Exception.Message) 7
}
if (-not ($check.dependencies.PSObject.Properties.Name -contains $PackageName)) {
    Fail 'the dependency row did not survive the edit; nothing was written' 7
}
if (@($check.dsh.profile.bundles) -notcontains $PackageName) {
    Fail 'the bundle row did not survive the edit; nothing was written' 7
}

Write-JsonFile $PackageJson $newJson
Ok 'package.json updated (dependency + bundle)'

# -------------------------------------------------------------- 7. the junction

if (-not (Test-Path -LiteralPath $NodeModules)) {
    New-Item -ItemType Directory -Path $NodeModules -Force | Out-Null
}
if (Test-Path -LiteralPath $LinkPath) {
    $item = Get-Item -LiteralPath $LinkPath -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        [System.IO.Directory]::Delete($LinkPath, $false)
        Note 'removed the previous junction'
    } else {
        Remove-Item -LiteralPath $LinkPath -Recurse -Force
        Note 'removed a real directory at the link path'
    }
}
New-Item -ItemType Junction -Path $LinkPath -Target $TargetDir | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $LinkPath 'package.json'))) {
    Fail 'the junction does not resolve; module resolution would fail' 8
}
Ok ('node_modules junction created: ' + $LinkPath)

# ------------------------------------------------------------------ 8. result

Write-Host ''
Write-Host 'INSTALL COMPLETED' -ForegroundColor Green
Write-Host '-----------------' -ForegroundColor Green
Note 'Start DSH Desktop. Open any session: the button sits just above the'
Note 'composer, right aligned — [✨ 优化提示词].'
Note ''
Note ('host health : http://127.0.0.1:<port>/prompt-optimizer/health')
Note ('uninstall   : ' + (Join-Path $PSScriptRoot 'uninstall.bat'))
Note ('backup      : ' + (Join-Path $SnapshotDir 'package.json.orig'))
exit 0
