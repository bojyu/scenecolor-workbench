Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PageUrl = 'http://localhost:5173/'
$ApiUrl = 'http://localhost:3001/'

function Test-HttpUrl {
    param([Parameter(Mandatory = $true)][string]$Url)

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    }
    catch {
        return $false
    }
}

function Open-DefaultBrowser {
    param([Parameter(Mandatory = $true)][string]$Url)

    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Url
    $info.UseShellExecute = $true
    [System.Diagnostics.Process]::Start($info) | Out-Null
}

try {
    Set-Location -LiteralPath $AppDir

    $packagePath = Join-Path $AppDir 'package.json'
    if (-not (Test-Path -LiteralPath $packagePath)) {
        throw 'package.json was not found next to the launcher.'
    }

    $nodeCommand = Get-Command 'node.exe' -ErrorAction SilentlyContinue
    $npmCommand = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
    if (($null -eq $nodeCommand) -or ($null -eq $npmCommand)) {
        throw 'Node.js is not installed or is not available in PATH.'
    }

    $pageOnline = Test-HttpUrl -Url $PageUrl
    $apiOnline = Test-HttpUrl -Url $ApiUrl
    if ($pageOnline -and $apiOnline) {
        Write-Host '[OK] SceneColor is already running. Opening the workbench...'
        Open-DefaultBrowser -Url $PageUrl
        exit 0
    }

    if ($pageOnline -or $apiOnline) {
        throw 'Only part of SceneColor is running. Stop the stale process using port 5173 or 3001, then run this launcher again.'
    }

    $nodeModules = Join-Path $AppDir 'node_modules'
    if (-not (Test-Path -LiteralPath $nodeModules)) {
        Write-Host '[INFO] Dependencies are missing. Running npm ci...'
        & $npmCommand.Source ci
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed with exit code $LASTEXITCODE."
        }
    }

    $openerPath = Join-Path $AppDir 'wait-and-open-workbench.ps1'
    if (-not (Test-Path -LiteralPath $openerPath)) {
        throw 'wait-and-open-workbench.ps1 was not found next to the launcher.'
    }

    $powerShellPath = Join-Path $PSHOME 'powershell.exe'
    if (-not (Test-Path -LiteralPath $powerShellPath)) {
        $powerShellPath = 'powershell.exe'
    }

    $quotedOpener = '"' + $openerPath + '"'
    $waiterInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $waiterInfo.FileName = $powerShellPath
    $waiterInfo.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File $quotedOpener"
    $waiterInfo.WorkingDirectory = $AppDir
    $waiterInfo.UseShellExecute = $true
    $waiterInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    [System.Diagnostics.Process]::Start($waiterInfo) | Out-Null

    Write-Host '[INFO] Starting SceneColor...'
    Write-Host '[INFO] The browser will open when the workbench is ready.'
    Write-Host '[INFO] Keep this window open. Press Ctrl+C to stop SceneColor.'
    Write-Host ''

    & $npmCommand.Source run dev
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "SceneColor stopped with exit code $exitCode."
    }

    exit 0
}
catch {
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
