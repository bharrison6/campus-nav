# deploy.ps1 — Automated Apps Script deploy
# Usage: cd scripts/apps-script && powershell -ExecutionPolicy Bypass -File deploy.ps1

param([string]$Description = "")

$DeployId  = "AKfycbxM-sMOC8CQQf2ckPX6MgZHZsnWu-oAWKp0DeuqbEp3idjSKGZUY288zN_KhXlwbhy53Q"
$DeployUrl = "https://script.google.com/macros/s/$DeployId/exec"

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$ts = Get-Date -Format "yyyy-MM-dd HH:mm"
if (-not $Description) { $Description = "auto-deploy $ts" }

Write-Host "[1/3] Pushing files..." -ForegroundColor Cyan
clasp push --force
if ($LASTEXITCODE -ne 0) { Write-Error "clasp push failed"; exit 1 }

Write-Host "[2/3] Creating version snapshot..." -ForegroundColor Cyan
$versionOutput = clasp create-version $Description 2>&1
Write-Host $versionOutput
if ($versionOutput -match 'Created version (\d+)') {
    $versionNum = [int]$Matches[1]
} else {
    Write-Error "Could not parse version number from: $versionOutput"; exit 1
}

Write-Host "[3/3] Deploying version $versionNum..." -ForegroundColor Cyan
clasp create-deployment -i $DeployId -V $versionNum -d $Description
if ($LASTEXITCODE -ne 0) { Write-Error "clasp create-deployment failed"; exit 1 }

Write-Host ""
Write-Host "Done! Version $versionNum is live." -ForegroundColor Green
Write-Host "  URL: $DeployUrl"
