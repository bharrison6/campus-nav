# deploy.ps1 - Push, version, and redeploy the permanent web app deployment.
# Usage: cd scripts/apps-script; pwsh -File deploy.ps1 [-Description "what changed"]
#
# Sequence: push -> new version -> point the existing deployment at that version,
# so the /exec URL never changes. Works with clasp 2.x (version / deploy -i) and
# clasp 3.x (create-version / create-deployment -i); clasp 3.2's
# update-deployment is broken and is never used.
# Needs scripts/apps-script/.clasp.json (gitignored; holds the script id).

param([string]$Description = "")

$DeployId  = "AKfycbwK7uZ5SDu_PIDrUfWYj7866Y4gbs68cbQxxLZN4kQs0iv5EpiKeR62qBGOfk75CEo"
$DeployUrl = "https://script.google.com/macros/s/$DeployId/exec"

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".clasp.json")) {
    Write-Error "No .clasp.json here. Run 'clasp clone <scriptId> --rootDir ./src' (script id: Apps Script editor, Project Settings) first."
    exit 1
}

$ts = Get-Date -Format "yyyy-MM-dd HH:mm"
if (-not $Description) { $Description = "auto-deploy $ts" }

$claspVersion = (clasp --version 2>&1 | Out-String).Trim()
$claspMajor = 0
if ($claspVersion -match '^(\d+)\.') { $claspMajor = [int]$Matches[1] }
Write-Host "clasp $claspVersion" -ForegroundColor DarkGray

Write-Host "[1/3] Pushing files..." -ForegroundColor Cyan
clasp push --force
if ($LASTEXITCODE -ne 0) { Write-Error "clasp push failed"; exit 1 }

Write-Host "[2/3] Creating version snapshot..." -ForegroundColor Cyan
if ($claspMajor -ge 3) {
    $versionOutput = clasp create-version $Description 2>&1 | Out-String
} else {
    $versionOutput = clasp version $Description 2>&1 | Out-String
}
Write-Host $versionOutput.Trim()
if ($versionOutput -match 'Created version (\d+)') {
    $versionNum = [int]$Matches[1]
} else {
    Write-Error "Could not parse version number from: $versionOutput"; exit 1
}

Write-Host "[3/3] Deploying version $versionNum..." -ForegroundColor Cyan
if ($claspMajor -ge 3) {
    clasp create-deployment -i $DeployId -V $versionNum -d $Description
} else {
    clasp deploy -i $DeployId -V $versionNum -d $Description
}
if ($LASTEXITCODE -ne 0) { Write-Error "clasp deploy failed"; exit 1 }

Write-Host ""
Write-Host "Done! Version $versionNum is live." -ForegroundColor Green
Write-Host "  URL: $DeployUrl"
Write-Host "  Record it in DEPLOYMENT.md (Deployment history)."
