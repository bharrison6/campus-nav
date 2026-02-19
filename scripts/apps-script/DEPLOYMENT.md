# Apps Script Deployment Info

## Permanent Web App URL
https://script.google.com/macros/s/AKfycbxM-sMOC8CQQf2ckPX6MgZHZsnWu-oAWKp0DeuqbEp3idjSKGZUY288zN_KhXlwbhy53Q/exec
This URL never changes. All future deploys update the code behind it.

## Google Sheet
(will be populated after running ?action=init)

## Script Editor
https://script.google.com/d/1oEdoBjGZTmToLCCfW8Wyhn3uNJBQ-S9Zwvv8MmrHk2rDQ3XGfXUVbi7t/edit

## Google Maps API Key
***REMOVED-GOOGLE-MAPS-API-KEY***
Restricted to: Maps JavaScript API + Maps Embed API, referrers: script.google.com/*, *.googleusercontent.com/*
Google Cloud Project: personal account (shared project for multiple apps)
NOTE: If this repo ever becomes public, move this key to Config sheet only and remove from this file.

## How to deploy changes
cd scripts/apps-script
powershell -ExecutionPolicy Bypass -File deploy.ps1

## Deployment history
| Version | Date | Description |
|---------|------|-------------|
| 1       | 2026-02-19 | Initial scaffold with ping endpoint |
