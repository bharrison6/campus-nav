# Murray State Campus Navigation

An indoor navigation web app for Murray State University, providing room-level wayfinding with digitized floor plans and campus-wide walking directions.

## Overview

A Google Apps Script web app that combines A* pathfinding on digitized building floor plans with Google Maps walking directions between buildings. Currently targeting the engineering buildings on campus, with a computer vision pipeline for processing architectural floor plans into navigable room maps.

## Tech Stack

- **Google Apps Script** -- web app backend (HtmlService + Sheets data store)
- **clasp v3** -- local development and deployment
- **Python** (OpenCV) -- floor plan processing pipeline (isolation, room detection)
- **Google Maps API** -- campus-level walking directions

## Project Structure

```
scripts/apps-script/          -- GAS source files and clasp config
scripts/map-processing/       -- Python floor plan processing pipeline
Maps/                         -- Source floor plans and processed outputs
docs/plans/                   -- Design docs and implementation plan
```

## Current Status

- GAS web app scaffold complete with Sheets data model initialized
- Floor plan isolation pipeline working (text/branding removal)
- Room detection pipeline in progress (improving segmentation accuracy)
- Indoor A* pathfinding and Google Maps integration planned
