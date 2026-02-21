# Apps Script Deployment Info

## Permanent Web App URL
https://script.google.com/macros/s/AKfycbxM-sMOC8CQQf2ckPX6MgZHZsnWu-oAWKp0DeuqbEp3idjSKGZUY288zN_KhXlwbhy53Q/exec
This URL never changes. All future deploys update the code behind it.

## Google Sheet
https://docs.google.com/spreadsheets/d/1y_BCfyn-5AEauBcBuY2sPl1wc92bJ9t4mRoNemYkG_E/edit

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
| 2       | 2026-02-19 | Init.gs with sheet definitions and demo seed data |
| 3       | 2026-02-19 | API.gs with getAllCampusData and getDataVersion |
| 4       | 2026-02-19 | SPA shell with tab navigation and data caching |
| 5       | 2026-02-19 | Google Maps with building markers and info panel |
| 6       | 2026-02-19 | Canvas-based indoor floor plan viewer |
| 7       | 2026-02-19 | A* pathfinding with multi-floor routing |
| 8       | 2026-02-19 | QR code scanner with location and schedule handling |
| 9       | 2026-02-19 | Schedule builder with timeline, add event, navigate, share |
| 10      | 2026-02-19 | Pannellum panorama viewer with indoor and outdoor photo pins |
| 11      | 2026-02-19 | Pannellum quality fixes: viewer cleanup, error handling, Escape key |
| 12      | 2026-02-19 | Admin page with QR code generator (location + schedule + batch) |
| 13      | 2026-02-19 | Admin PIN authentication, input validation, CSRF fix |
| 14      | 2026-02-19 | Phase 0+1: Backend CRUD operations + canvas infrastructure |
| 15      | 2026-02-19 | Phases 2-6: All admin editor tabs (Floor Manager, Room Editor, Nav Graph, Entrances) |
| 16      | 2026-02-20 | Fix: Google Maps infinite recursion in Entrances tab |
| 17      | 2026-02-20 | Add Building CRUD: saveBuilding, deleteBuilding + Add Building UI |
| 18-19   | 2026-02-20 | Merge Buildings+Entrances into one tab, simplify Floor Plans |
| 20      | 2026-02-20 | Seed 89 buildings, 4 floors, 102 rooms with GPS data |
| 21-24   | 2026-02-20 | Floor plan images: server-side Drive fetch (CORS fix), 4 PNGs uploaded to Drive, SeedData updated with image URLs + dimensions |
| 25-29   | 2026-02-20 | Room center coordinates for all 102 rooms (EP from PDF text, IT estimated). Room labels visible in admin without polygons. Clickable label selection. |
| 30-33   | 2026-02-20 | Vector SVG floor plans: potrace B&W trace, rotation correction, IT split. 4 SVGs uploaded to Drive. SeedData updated with new URLs, dimensions, and adjusted room coordinates. |
