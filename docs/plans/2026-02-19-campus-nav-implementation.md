# Murray State Campus Navigation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Google Apps Script web app that lets students navigate Murray State's campus (building-to-building and room-to-room), view panoramic photos, scan QR codes for positioning, and manage a personal schedule.

**Architecture:** Pure GAS web app served by HtmlService, backed by Google Sheets. All campus data loaded on first visit and cached in localStorage. Indoor pathfinding via client-side A* on a manually-digitized navigation graph. QR codes for indoor positioning and schedule import.

**Tech Stack:** Google Apps Script (V8), Google Sheets, Google Maps Embed API, HTML Canvas, html5-qrcode, Pannellum, clasp v3

**Design Doc:** `docs/plans/2026-02-19-campus-nav-design.md`

**GAS Workflow Reference:** `C:\GitHub\workflows\google-apps-script-clasp.md`

---

## Prerequisites (Human-Assisted — Must Complete Before Task 1)

These steps require a browser and human interaction. They cannot be automated.

### P1: Verify clasp is installed

```bash
clasp --version
```

Expected: `3.x.x`. If not installed: `npm install -g @google/clasp`

### P2: Enable the Apps Script API

Visit: https://script.google.com/home/usersettings
Toggle "Google Apps Script API" to ON.

### P3: Authenticate clasp

```bash
clasp login
```

Sign in with the Google account that will own the project. Credentials saved to `~/.clasprc.json`.

### P4: Get a Google Maps API key

1. Go to https://console.cloud.google.com/
2. Create a new project (or use existing): "Murray State Campus Nav"
3. Enable **Maps Embed API** (free, unlimited)
4. Enable **Maps JavaScript API** (free tier: 10k loads/month)
5. Create an API key under Credentials
6. Restrict the key to Maps Embed API + Maps JavaScript API
7. Save the API key — you'll paste it into Config sheet later

**Note:** The Maps Embed API alone is sufficient for v1. The JavaScript API adds interactive markers but has usage limits. We'll start with Embed API and upgrade if needed.

---

## Phase 1: GAS Project Scaffold

### Task 1: Create project directory and clasp project

**Files:**
- Create: `scripts/apps-script/.clasp.json` (auto-generated)
- Create: `scripts/apps-script/appsscript.json`

**Step 1: Create the directory**

```bash
mkdir -p scripts/apps-script
```

**Step 2: Initialize clasp project**

```bash
cd scripts/apps-script
clasp create-script --type standalone --title "Murray State Campus Nav"
```

This creates `.clasp.json` with the `scriptId`.

**Step 3: Configure appsscript.json**

Replace the auto-generated file with:

```json
{
  "timeZone": "America/Chicago",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE_ANONYMOUS"
  },
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/script.external_request"
  ]
}
```

Note: `America/Chicago` is Murray State's timezone (Central).

**Step 4: Commit**

```bash
git add scripts/apps-script/.clasp.json scripts/apps-script/appsscript.json
git commit -m "feat: initialize clasp project for GAS web app"
```

---

### Task 2: Create Code.gs router with ping endpoint

**Files:**
- Create: `scripts/apps-script/Code.gs`

**Step 1: Write Code.gs**

```javascript
/**
 * Code.gs — Main router for Murray State Campus Navigation
 * Routes doGet/doPost requests by ?action= parameter.
 */

function doGet(e) {
  var params = e ? (e.parameter || {}) : {};
  var action = params.action || '';
  var qrParam = params.qr || '';

  // Serve the web app (default when no action specified)
  if (!action || action === 'web') {
    var html = HtmlService.createHtmlOutputFromFile('WebApp')
      .setTitle('Murray State Campus Nav')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

    // Pass QR parameter to the page if present
    if (qrParam) {
      html = HtmlService.createTemplate(
        HtmlService.createHtmlOutputFromFile('WebApp').getContent()
      );
      // We'll handle QR params client-side via URL parsing
    }

    return HtmlService.createHtmlOutputFromFile('WebApp')
      .setTitle('Murray State Campus Nav')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // API routes
  try {
    var data = routeAction(action, params);
    return jsonResponse({ ok: true, data: data });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var data = routeAction(body.action, body);
    return jsonResponse({ ok: true, data: data });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

function routeAction(action, params) {
  switch (action) {
    case 'ping':
      return 'pong';
    case 'init':
      return initSystem();
    case 'getAllCampusData':
      return getAllCampusData();
    case 'getDataVersion':
      return getDataVersion();
    default:
      throw new Error('Unknown action: ' + action);
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

**Step 2: Create a minimal WebApp.html placeholder**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Murray State Campus Nav</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; }
  </style>
</head>
<body>
  <h1>Murray State Campus Navigation</h1>
  <p>App loading... (placeholder)</p>
</body>
</html>
```

**Step 3: Push and verify**

```bash
cd scripts/apps-script
clasp push --force
```

**Step 4: First deployment via browser (one-time, human required)**

```bash
clasp open-script
```

In the browser:
1. Click **Deploy** → **New deployment**
2. Click gear icon → select **Web app**
3. Set Execute as: **Me**, Who has access: **Anyone**
4. Click **Deploy** → complete OAuth consent
5. Copy the deployment URL

**Step 5: Verify ping works**

```powershell
Invoke-WebRequest -Uri "DEPLOYMENT_URL?action=ping" -UseBasicParsing -MaximumRedirection 10 |
  Select-Object -ExpandProperty Content
```

Expected: `{"ok":true,"data":"pong"}`

**Step 6: Commit**

```bash
git add scripts/apps-script/Code.gs scripts/apps-script/WebApp.html
git commit -m "feat: add Code.gs router with ping endpoint and WebApp placeholder"
```

---

### Task 3: Create deploy.ps1 and DEPLOYMENT.md

**Files:**
- Create: `scripts/apps-script/deploy.ps1`
- Create: `scripts/apps-script/DEPLOYMENT.md`

**Step 1: Write deploy.ps1**

Copy the template from `C:\GitHub\workflows\google-apps-script-clasp.md` (the deploy.ps1 section). Replace `PASTE_YOUR_DEPLOYMENT_ID_HERE` with the actual deployment ID from the first deployment.

**Step 2: Write DEPLOYMENT.md**

```markdown
# Apps Script Deployment Info

## Permanent Web App URL
<paste exec URL here>
This URL never changes. All future deploys update the code behind it.

## Google Sheet
<paste sheet URL after running ?action=init>

## Script Editor
<paste editor URL here>

## Google Maps API Key
<paste API key here — do NOT commit this to git if repo is public>

## How to deploy changes
cd scripts/apps-script
powershell -ExecutionPolicy Bypass -File deploy.ps1

## Deployment history
| Version | Date | Description |
|---------|------|-------------|
| 1       | 2026-02-19 | Initial scaffold with ping endpoint |
```

**Step 3: Commit**

```bash
git add scripts/apps-script/deploy.ps1 scripts/apps-script/DEPLOYMENT.md
git commit -m "feat: add deploy script and deployment documentation"
```

---

## Phase 2: Data Model + Init System

### Task 4: Create Init.gs with all sheet definitions

**Files:**
- Create: `scripts/apps-script/Init.gs`

**Step 1: Write Init.gs**

```javascript
/**
 * Init.gs — One-time system initialization.
 * Creates the Google Sheet with all required tabs and headers.
 * Idempotent — safe to call multiple times.
 */

function initSystem() {
  var props = PropertiesService.getScriptProperties();
  var existingId = props.getProperty('SHEET_ID');

  if (existingId) {
    try {
      var ss = SpreadsheetApp.openById(existingId);
      // Verify all sheets exist, create any missing ones
      _ensureAllSheets(ss);
      return { alreadyInitialized: true, url: ss.getUrl() };
    } catch (e) {
      // Sheet was deleted, fall through to create new one
    }
  }

  var ss = SpreadsheetApp.create('Murray State Campus Nav - Data');
  props.setProperty('SHEET_ID', ss.getId());
  _ensureAllSheets(ss);
  _seedDemoData(ss);
  return { initialized: true, url: ss.getUrl() };
}

function _ensureAllSheets(ss) {
  var sheetDefs = _getSheetDefinitions();
  for (var i = 0; i < sheetDefs.length; i++) {
    var def = sheetDefs[i];
    var sheet = ss.getSheetByName(def.name);
    if (!sheet) {
      sheet = ss.insertSheet(def.name);
      sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
      sheet.setFrozenRows(1);
      // Bold the header row
      sheet.getRange(1, 1, 1, def.headers.length).setFontWeight('bold');
    }
  }
  // Remove the default "Sheet1" if it exists and is empty
  var sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && sheet1.getLastRow() <= 1 && ss.getSheets().length > 1) {
    ss.deleteSheet(sheet1);
  }
}

function _getSheetDefinitions() {
  return [
    {
      name: 'Config',
      headers: ['key', 'value']
    },
    {
      name: 'Buildings',
      headers: ['id', 'name', 'lat', 'lng', 'entrances', 'photoUrl']
    },
    {
      name: 'Floors',
      headers: ['id', 'buildingId', 'level', 'label', 'planImageUrl', 'widthPx', 'heightPx', 'metersPerPixel']
    },
    {
      name: 'Rooms',
      headers: ['id', 'floorId', 'number', 'label', 'polygon', 'centerX', 'centerY']
    },
    {
      name: 'NavNodes',
      headers: ['id', 'floorId', 'x', 'y', 'type', 'roomId']
    },
    {
      name: 'NavEdges',
      headers: ['id', 'fromNodeId', 'toNodeId', 'distance', 'floorChange']
    },
    {
      name: 'Photos',
      headers: ['id', 'type', 'buildingId', 'floorId', 'x', 'y', 'lat', 'lng', 'driveUrl', 'caption', 'heading']
    },
    {
      name: 'QRLocations',
      headers: ['id', 'buildingId', 'floorId', 'nodeId', 'description', 'permanent', 'expires', 'createdDate']
    }
  ];
}

function _seedDemoData(ss) {
  // Seed Config with version
  var configSheet = ss.getSheetByName('Config');
  configSheet.getRange(2, 1, 2, 2).setValues([
    ['dataVersion', '1'],
    ['mapsApiKey', '']
  ]);

  // Seed a demo building (Murray State Engineering Building placeholder)
  // Real data will be populated during floor plan digitization
  var buildingsSheet = ss.getSheetByName('Buildings');
  buildingsSheet.getRange(2, 1, 1, 6).setValues([[
    'eng1',
    'Engineering & Physics Building',
    36.6622,
    -88.3253,
    JSON.stringify([
      { name: 'Main Entrance', lat: 36.6622, lng: -88.3253, nodeId: 'eng1-entrance-main' }
    ]),
    ''
  ]]);
}
```

**Step 2: Push, deploy, and test**

```bash
cd scripts/apps-script && clasp push --force
```

Then deploy and hit `?action=init`. Verify the Sheet is created with all tabs.

**Step 3: Commit**

```bash
git add scripts/apps-script/Init.gs
git commit -m "feat: add Init.gs with sheet definitions and demo seed data"
```

---

### Task 5: Create API.gs with data fetch endpoints

**Files:**
- Create: `scripts/apps-script/API.gs`

**Step 1: Write API.gs**

```javascript
/**
 * API.gs — Data access layer.
 * All functions that read/write the Google Sheet.
 */

/**
 * Returns the current data version number from Config sheet.
 */
function getDataVersion() {
  var ss = _getSpreadsheet();
  var configSheet = ss.getSheetByName('Config');
  var data = configSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === 'dataVersion') {
      return data[i][1];
    }
  }
  return '0';
}

/**
 * Returns all campus data in a single payload.
 * Called on first load; client caches this in localStorage.
 */
function getAllCampusData() {
  var ss = _getSpreadsheet();
  return {
    version: getDataVersion(),
    config: _sheetToObjects(ss, 'Config'),
    buildings: _sheetToObjects(ss, 'Buildings'),
    floors: _sheetToObjects(ss, 'Floors'),
    rooms: _sheetToObjects(ss, 'Rooms'),
    navNodes: _sheetToObjects(ss, 'NavNodes'),
    navEdges: _sheetToObjects(ss, 'NavEdges'),
    photos: _sheetToObjects(ss, 'Photos'),
    qrLocations: _sheetToObjects(ss, 'QRLocations')
  };
}

/**
 * Reads a sheet and returns an array of objects keyed by header row.
 */
function _sheetToObjects(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  var headers = data[0];
  var results = [];
  for (var r = 1; r < data.length; r++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      var val = data[r][c];
      // Auto-parse JSON strings (for entrances, polygon, etc.)
      if (typeof val === 'string' && val.length > 0 && (val[0] === '[' || val[0] === '{')) {
        try { val = JSON.parse(val); } catch (e) { /* keep as string */ }
      }
      obj[headers[c]] = val;
    }
    results.push(obj);
  }
  return results;
}

/**
 * Gets the project spreadsheet. Throws if not initialized.
 */
function _getSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('SHEET_ID');
  if (!sheetId) {
    throw new Error('System not initialized. Call ?action=init first.');
  }
  return SpreadsheetApp.openById(sheetId);
}
```

**Step 2: Push and test**

```bash
cd scripts/apps-script && clasp push --force
```

Deploy, then test: `?action=getAllCampusData`
Expected: JSON with `ok: true` and all sheet data including the seeded demo building.

**Step 3: Commit**

```bash
git add scripts/apps-script/API.gs
git commit -m "feat: add API.gs with getAllCampusData and data version check"
```

---

## Phase 3: Web App Shell + Campus Map

### Task 6: Build the SPA shell with navigation tabs

**Files:**
- Modify: `scripts/apps-script/WebApp.html`

**Step 1: Write the full SPA shell**

Replace the placeholder WebApp.html with a single-page app structure. Include:

- Bottom navigation tabs: **Map**, **Indoor**, **Schedule**, **Scan**
- A loading screen that shows while data is being fetched
- Data loading logic: call `google.script.run.getAllCampusData()`, cache in `localStorage`
- Version check: call `google.script.run.getDataVersion()` on each load, refresh cache if version changed
- QR parameter handling: parse `?qr=` from the URL for deep-link QR codes
- CSS: mobile-first responsive design, full viewport height, no scrollbar on main container

Key HTML structure:

```html
<div id="app">
  <div id="loading-screen">Loading campus data...</div>
  <div id="main-content" style="display:none">
    <div id="view-map" class="view active"></div>
    <div id="view-indoor" class="view"></div>
    <div id="view-schedule" class="view"></div>
    <div id="view-scan" class="view"></div>
  </div>
  <nav id="bottom-nav">
    <button data-view="map" class="active">Map</button>
    <button data-view="indoor">Indoor</button>
    <button data-view="schedule">Schedule</button>
    <button data-view="scan">Scan</button>
  </nav>
</div>
```

Key JavaScript:

```javascript
var campusData = null;

function initApp() {
  var cached = localStorage.getItem('campusData');
  var cachedVersion = localStorage.getItem('campusDataVersion');

  if (cached && cachedVersion) {
    // Check if version is current
    google.script.run
      .withSuccessHandler(function(serverVersion) {
        if (String(serverVersion) === String(cachedVersion)) {
          campusData = JSON.parse(cached);
          onDataReady();
        } else {
          fetchAllData();
        }
      })
      .withFailureHandler(function() {
        // Offline or error — use cached data
        campusData = JSON.parse(cached);
        onDataReady();
      })
      .getDataVersion();
  } else {
    fetchAllData();
  }
}

function fetchAllData() {
  google.script.run
    .withSuccessHandler(function(data) {
      campusData = data;
      localStorage.setItem('campusData', JSON.stringify(data));
      localStorage.setItem('campusDataVersion', data.version);
      onDataReady();
    })
    .withFailureHandler(function(err) {
      document.getElementById('loading-screen').textContent =
        'Failed to load data: ' + err.message;
    })
    .getAllCampusData();
}

function onDataReady() {
  document.getElementById('loading-screen').style.display = 'none';
  document.getElementById('main-content').style.display = 'block';
  initMap();
  handleQrParam();
}
```

**Step 2: Push, deploy, verify the app loads**

```bash
cd scripts/apps-script
powershell -ExecutionPolicy Bypass -File deploy.ps1
```

Open the app URL in a mobile browser. Verify:
- Loading screen appears briefly
- Data loads and tabs are visible
- Switching tabs works
- Check localStorage in DevTools — campusData should be cached

**Step 3: Commit**

```bash
git add scripts/apps-script/WebApp.html
git commit -m "feat: build SPA shell with tab navigation and data caching"
```

---

### Task 7: Integrate Google Maps with building markers

**Files:**
- Modify: `scripts/apps-script/WebApp.html` (Map view section)

**Step 1: Add Google Maps to the Map view**

In the `#view-map` div, embed a Google Map using the Maps JavaScript API. The API key comes from the Config sheet (stored in `campusData.config`).

Key implementation:

```javascript
var map;
var buildingMarkers = [];

function initMap() {
  var apiKey = getConfigValue('mapsApiKey');
  if (!apiKey) {
    document.getElementById('view-map').innerHTML =
      '<p>Google Maps API key not configured. Add it to the Config sheet.</p>';
    return;
  }

  // Dynamically load the Maps JavaScript API
  var script = document.createElement('script');
  script.src = 'https://maps.googleapis.com/maps/api/js?key=' + apiKey +
    '&callback=onMapsLoaded';
  document.head.appendChild(script);
}

function onMapsLoaded() {
  // Center on Murray State campus
  map = new google.maps.Map(document.getElementById('map-container'), {
    center: { lat: 36.6622, lng: -88.3253 },
    zoom: 16,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false
  });

  // Add building markers
  campusData.buildings.forEach(function(building) {
    var marker = new google.maps.Marker({
      position: { lat: Number(building.lat), lng: Number(building.lng) },
      map: map,
      title: building.name
    });

    var hasFloors = campusData.floors.some(function(f) {
      return f.buildingId === building.id;
    });

    marker.addListener('click', function() {
      showBuildingInfo(building, hasFloors);
    });

    buildingMarkers.push({ marker: marker, building: building });
  });
}

function showBuildingInfo(building, hasFloors) {
  // Show a bottom sheet / info panel with:
  // - Building name
  // - List of entrances with "Navigate" button each
  // - "View Inside" button if hasFloors is true
}
```

Also add photo pin markers (camera icons) for outdoor photos:

```javascript
function addPhotoMarkers() {
  campusData.photos.forEach(function(photo) {
    if (photo.type === 'outdoor' && photo.lat && photo.lng) {
      var marker = new google.maps.Marker({
        position: { lat: Number(photo.lat), lng: Number(photo.lng) },
        map: map,
        icon: {
          url: 'data:image/svg+xml,...', // camera icon SVG
          scaledSize: new google.maps.Size(24, 24)
        },
        title: photo.caption
      });
      marker.addListener('click', function() {
        showPanorama(photo);
      });
    }
  });
}
```

**Step 2: Push, deploy, test**

Open the app. Verify:
- Map loads centered on Murray State campus
- Demo building marker appears
- Clicking marker shows building info
- Photo markers appear (if any photos exist in sheet)

**Step 3: Commit**

```bash
git add scripts/apps-script/WebApp.html
git commit -m "feat: integrate Google Maps with building markers and info panel"
```

---

### Task 8: Add walking directions

**Files:**
- Modify: `scripts/apps-script/WebApp.html` (directions logic)

**Step 1: Implement walking directions**

When a student taps "Navigate" on a building entrance, show walking directions. Two approaches in order of preference:

**Primary: Google Maps deep-link (reliable, opens native Maps or in-browser):**

```javascript
function navigateToEntrance(entrance) {
  var url = 'https://www.google.com/maps/dir/?api=1' +
    '&destination=' + entrance.lat + ',' + entrance.lng +
    '&travelmode=walking';
  window.open(url, '_blank');
}
```

**Secondary: Inline directions via Maps JavaScript API DirectionsService:**

```javascript
function showInlineDirections(entrance) {
  if (!navigator.geolocation) {
    navigateToEntrance(entrance); // fallback to deep-link
    return;
  }
  navigator.geolocation.getCurrentPosition(function(pos) {
    var directionsService = new google.maps.DirectionsService();
    var directionsRenderer = new google.maps.DirectionsRenderer({ map: map });
    directionsService.route({
      origin: { lat: pos.coords.latitude, lng: pos.coords.longitude },
      destination: { lat: Number(entrance.lat), lng: Number(entrance.lng) },
      travelMode: 'WALKING'
    }, function(result, status) {
      if (status === 'OK') {
        directionsRenderer.setDirections(result);
      } else {
        navigateToEntrance(entrance); // fallback
      }
    });
  }, function() {
    navigateToEntrance(entrance); // geolocation denied, fallback
  });
}
```

Start with the deep-link approach — it's simpler, always works, and leverages the native Google Maps experience. Add inline directions as an enhancement later if needed.

**Step 2: Implement entrance selection for multi-entrance buildings**

When a building has multiple entrances, show a list:

```javascript
function showBuildingInfo(building, hasFloors) {
  var entrances = building.entrances || [];
  // Render: building name, entrance list with Navigate buttons
  // If hasFloors, add "View Inside" button
}
```

**Step 3: Push, deploy, test**

Verify:
- Tapping Navigate on a building entrance opens Google Maps with walking directions
- Multi-entrance buildings show all entrance options

**Step 4: Commit**

```bash
git add scripts/apps-script/WebApp.html
git commit -m "feat: add walking directions via Google Maps deep-link"
```

---

## Phase 4: Indoor Floor Plan Viewer

### Task 9: Build the canvas-based floor plan renderer

**Files:**
- Modify: `scripts/apps-script/WebApp.html` (Indoor view section)

**Step 1: Implement the floor plan viewer**

The `#view-indoor` div shows:
- A building selector dropdown (populated from campusData.buildings, filtered to those with floors)
- Floor selector buttons (e.g., "1F", "2F")
- An HTML Canvas that renders the floor plan image with room overlays

Key implementation:

```javascript
var indoorCanvas, indoorCtx;
var currentBuilding = null;
var currentFloor = null;
var floorPlanImage = null;
var canvasScale = 1;
var canvasOffsetX = 0, canvasOffsetY = 0;

function initIndoorView() {
  indoorCanvas = document.getElementById('indoor-canvas');
  indoorCtx = indoorCanvas.getContext('2d');

  // Set canvas to fill the view
  resizeIndoorCanvas();
  window.addEventListener('resize', resizeIndoorCanvas);

  // Touch/mouse handlers for pan and zoom
  setupCanvasInteraction(indoorCanvas);
}

function loadFloorPlan(buildingId, floorLevel) {
  currentBuilding = campusData.buildings.find(function(b) { return b.id === buildingId; });
  currentFloor = campusData.floors.find(function(f) {
    return f.buildingId === buildingId && f.level == floorLevel;
  });
  if (!currentFloor) return;

  floorPlanImage = new Image();
  floorPlanImage.crossOrigin = 'anonymous';
  floorPlanImage.onload = function() {
    renderFloorPlan();
  };
  floorPlanImage.src = currentFloor.planImageUrl;
}

function renderFloorPlan() {
  indoorCtx.clearRect(0, 0, indoorCanvas.width, indoorCanvas.height);
  indoorCtx.save();
  indoorCtx.translate(canvasOffsetX, canvasOffsetY);
  indoorCtx.scale(canvasScale, canvasScale);

  // Draw floor plan image
  if (floorPlanImage) {
    indoorCtx.drawImage(floorPlanImage, 0, 0);
  }

  // Draw room polygons (semi-transparent fill + border)
  var rooms = campusData.rooms.filter(function(r) {
    return r.floorId === currentFloor.id;
  });
  rooms.forEach(function(room) {
    drawRoomPolygon(room);
  });

  // Draw navigation path if active
  if (currentNavPath) {
    drawNavPath(currentNavPath);
  }

  // Draw photo pins
  drawIndoorPhotoMarkers();

  indoorCtx.restore();
}

function drawRoomPolygon(room) {
  var polygon = room.polygon;
  if (!polygon || !polygon.length) return;

  indoorCtx.beginPath();
  indoorCtx.moveTo(polygon[0][0], polygon[0][1]);
  for (var i = 1; i < polygon.length; i++) {
    indoorCtx.lineTo(polygon[i][0], polygon[i][1]);
  }
  indoorCtx.closePath();
  indoorCtx.fillStyle = 'rgba(66, 133, 244, 0.15)';
  indoorCtx.fill();
  indoorCtx.strokeStyle = 'rgba(66, 133, 244, 0.6)';
  indoorCtx.lineWidth = 1;
  indoorCtx.stroke();

  // Draw room number label at center
  if (room.number) {
    indoorCtx.fillStyle = '#333';
    indoorCtx.font = '11px system-ui';
    indoorCtx.textAlign = 'center';
    indoorCtx.fillText(room.number, room.centerX, room.centerY);
  }
}
```

**Step 2: Implement canvas interaction (pan/zoom/tap)**

```javascript
function setupCanvasInteraction(canvas) {
  // Pinch-to-zoom on mobile
  var lastTouchDist = 0;
  var lastTouchX = 0, lastTouchY = 0;
  var isDragging = false;

  canvas.addEventListener('touchstart', function(e) {
    if (e.touches.length === 1) {
      isDragging = true;
      lastTouchX = e.touches[0].clientX;
      lastTouchY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      lastTouchDist = getTouchDistance(e.touches);
    }
    e.preventDefault();
  });

  canvas.addEventListener('touchmove', function(e) {
    if (e.touches.length === 1 && isDragging) {
      var dx = e.touches[0].clientX - lastTouchX;
      var dy = e.touches[0].clientY - lastTouchY;
      canvasOffsetX += dx;
      canvasOffsetY += dy;
      lastTouchX = e.touches[0].clientX;
      lastTouchY = e.touches[0].clientY;
      renderFloorPlan();
    } else if (e.touches.length === 2) {
      var dist = getTouchDistance(e.touches);
      var scaleDelta = dist / lastTouchDist;
      canvasScale *= scaleDelta;
      canvasScale = Math.max(0.3, Math.min(5, canvasScale));
      lastTouchDist = dist;
      renderFloorPlan();
    }
    e.preventDefault();
  });

  canvas.addEventListener('touchend', function(e) {
    isDragging = false;
    // Detect tap (short touch with no significant movement)
    // Check which room was tapped
  });

  // Click handler for room taps
  canvas.addEventListener('click', function(e) {
    var rect = canvas.getBoundingClientRect();
    var canvasX = (e.clientX - rect.left - canvasOffsetX) / canvasScale;
    var canvasY = (e.clientY - rect.top - canvasOffsetY) / canvasScale;
    handleFloorPlanTap(canvasX, canvasY);
  });
}

function handleFloorPlanTap(x, y) {
  // Check if tap is inside any room polygon
  var rooms = campusData.rooms.filter(function(r) {
    return r.floorId === currentFloor.id;
  });
  for (var i = 0; i < rooms.length; i++) {
    if (isPointInPolygon(x, y, rooms[i].polygon)) {
      showRoomInfo(rooms[i]);
      return;
    }
  }
}

function isPointInPolygon(x, y, polygon) {
  if (!polygon || polygon.length < 3) return false;
  var inside = false;
  for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    var xi = polygon[i][0], yi = polygon[i][1];
    var xj = polygon[j][0], yj = polygon[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
```

**Step 3: Implement room info popup**

When a room is tapped, show a small panel with:
- Room number and label
- "Navigate Here" button
- "Set as Start" button (for manually selecting starting position)

**Step 4: Push, deploy, test**

Test with the demo building data. Even without real floor plan images yet, verify:
- Building selector dropdown works
- Floor buttons render
- Canvas renders (will be empty until real floor plan images are uploaded)
- Room tap detection works with synthetic test data

**Step 5: Commit**

```bash
git add scripts/apps-script/WebApp.html
git commit -m "feat: build canvas-based indoor floor plan viewer with pan/zoom/tap"
```

---

## Phase 5: Indoor Pathfinding

### Task 10: Implement A* pathfinding algorithm

**Files:**
- Modify: `scripts/apps-script/WebApp.html` (add pathfinding module)

**Step 1: Write the A* algorithm**

This runs entirely client-side. It operates on the NavNodes and NavEdges from campusData.

```javascript
/**
 * A* pathfinding on the navigation graph.
 * Returns an ordered array of node objects from start to goal.
 * Handles multi-floor routing via staircase/elevator nodes.
 */
function findPath(startNodeId, goalNodeId) {
  var nodes = {};
  campusData.navNodes.forEach(function(n) {
    nodes[n.id] = n;
  });

  var startNode = nodes[startNodeId];
  var goalNode = nodes[goalNodeId];
  if (!startNode || !goalNode) return null;

  // Build adjacency list
  var adjacency = {};
  campusData.navEdges.forEach(function(edge) {
    if (!adjacency[edge.fromNodeId]) adjacency[edge.fromNodeId] = [];
    if (!adjacency[edge.toNodeId]) adjacency[edge.toNodeId] = [];
    adjacency[edge.fromNodeId].push({ nodeId: edge.toNodeId, distance: Number(edge.distance), floorChange: edge.floorChange });
    adjacency[edge.toNodeId].push({ nodeId: edge.fromNodeId, distance: Number(edge.distance), floorChange: edge.floorChange });
  });

  // A* with Euclidean heuristic
  function heuristic(nodeA, nodeB) {
    var dx = Number(nodeA.x) - Number(nodeB.x);
    var dy = Number(nodeA.y) - Number(nodeB.y);
    // Add floor penalty to encourage staying on same floor when possible
    var floorPenalty = (nodeA.floorId !== nodeB.floorId) ? 200 : 0;
    return Math.sqrt(dx * dx + dy * dy) + floorPenalty;
  }

  var openSet = [startNodeId];
  var cameFrom = {};
  var gScore = {};
  var fScore = {};

  gScore[startNodeId] = 0;
  fScore[startNodeId] = heuristic(startNode, goalNode);

  while (openSet.length > 0) {
    // Get node with lowest fScore
    openSet.sort(function(a, b) { return (fScore[a] || Infinity) - (fScore[b] || Infinity); });
    var currentId = openSet.shift();

    if (currentId === goalNodeId) {
      // Reconstruct path
      var path = [nodes[currentId]];
      while (cameFrom[currentId]) {
        currentId = cameFrom[currentId];
        path.unshift(nodes[currentId]);
      }
      return path;
    }

    var neighbors = adjacency[currentId] || [];
    for (var i = 0; i < neighbors.length; i++) {
      var neighbor = neighbors[i];
      var tentativeG = (gScore[currentId] || Infinity) + neighbor.distance;
      if (tentativeG < (gScore[neighbor.nodeId] || Infinity)) {
        cameFrom[neighbor.nodeId] = currentId;
        gScore[neighbor.nodeId] = tentativeG;
        fScore[neighbor.nodeId] = tentativeG + heuristic(nodes[neighbor.nodeId], goalNode);
        if (openSet.indexOf(neighbor.nodeId) === -1) {
          openSet.push(neighbor.nodeId);
        }
      }
    }
  }

  return null; // No path found
}
```

**Step 2: Draw the navigation path on canvas**

```javascript
var currentNavPath = null;

function navigateToRoom(room) {
  if (!currentStartNode) {
    showMessage('Scan a QR code or select an entrance to set your starting position.');
    return;
  }

  // Find the nav node associated with this room
  var roomNode = campusData.navNodes.find(function(n) {
    return n.roomId === room.id;
  });
  if (!roomNode) {
    showMessage('No navigation data for this room.');
    return;
  }

  currentNavPath = findPath(currentStartNode.id, roomNode.id);
  if (!currentNavPath) {
    showMessage('No path found to ' + room.number);
    return;
  }

  // Render the path
  renderFloorPlan();
  showNavigationInstructions(currentNavPath);
}

function drawNavPath(path) {
  if (!path || path.length < 2) return;

  // Group path nodes by floor
  var floorSegments = [];
  var currentSegment = [path[0]];
  for (var i = 1; i < path.length; i++) {
    if (path[i].floorId !== path[i - 1].floorId) {
      floorSegments.push(currentSegment);
      currentSegment = [path[i]];
    } else {
      currentSegment.push(path[i]);
    }
  }
  floorSegments.push(currentSegment);

  // Draw only the segment for the currently viewed floor
  floorSegments.forEach(function(segment) {
    if (segment[0].floorId !== currentFloor.id) return;

    indoorCtx.beginPath();
    indoorCtx.moveTo(segment[0].x, segment[0].y);
    for (var i = 1; i < segment.length; i++) {
      indoorCtx.lineTo(segment[i].x, segment[i].y);
    }
    indoorCtx.strokeStyle = '#4285F4';
    indoorCtx.lineWidth = 4;
    indoorCtx.lineCap = 'round';
    indoorCtx.lineJoin = 'round';
    indoorCtx.stroke();

    // Draw start marker (green dot)
    indoorCtx.beginPath();
    indoorCtx.arc(segment[0].x, segment[0].y, 6, 0, 2 * Math.PI);
    indoorCtx.fillStyle = '#34A853';
    indoorCtx.fill();

    // Draw end marker (red dot)
    var last = segment[segment.length - 1];
    indoorCtx.beginPath();
    indoorCtx.arc(last.x, last.y, 6, 0, 2 * Math.PI);
    indoorCtx.fillStyle = '#EA4335';
    indoorCtx.fill();
  });
}
```

**Step 3: Show navigation instructions for multi-floor routes**

```javascript
function showNavigationInstructions(path) {
  var instructions = [];
  for (var i = 1; i < path.length; i++) {
    if (path[i].floorId !== path[i - 1].floorId) {
      var fromFloor = campusData.floors.find(function(f) { return f.id === path[i - 1].floorId; });
      var toFloor = campusData.floors.find(function(f) { return f.id === path[i].floorId; });
      var viaType = path[i - 1].type; // 'staircase' or 'elevator'
      instructions.push(
        'Go to ' + (toFloor ? toFloor.label : 'next floor') +
        ' via ' + viaType
      );
    }
  }
  // Display instructions in a panel below the canvas
  if (instructions.length > 0) {
    showFloorChangeInstructions(instructions);
  }
}
```

**Step 4: Push, deploy, test**

Test with synthetic nav graph data in the sheet. Verify:
- A* finds paths between nodes
- Path renders on the canvas
- Multi-floor instructions appear for cross-floor routes
- "No path found" shown when no connection exists

**Step 5: Commit**

```bash
git add scripts/apps-script/WebApp.html
git commit -m "feat: implement A* pathfinding with multi-floor routing and path rendering"
```

---

## Phase 6: QR Code System

### Task 11: Integrate html5-qrcode scanner

**Files:**
- Modify: `scripts/apps-script/WebApp.html` (Scan view section)

**Step 1: Add html5-qrcode library**

Load via CDN in the HTML `<head>`:

```html
<script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
```

**Step 2: Build the scanner view**

The `#view-scan` div contains:
- A camera viewfinder area
- Start/Stop scan button
- Result display area

```javascript
var qrScanner = null;

function initScanView() {
  document.getElementById('btn-start-scan').addEventListener('click', startScan);
}

function startScan() {
  var viewfinder = document.getElementById('qr-viewfinder');
  qrScanner = new Html5Qrcode('qr-viewfinder');

  qrScanner.start(
    { facingMode: 'environment' }, // rear camera
    { fps: 10, qrbox: { width: 250, height: 250 } },
    function onSuccess(decodedText) {
      qrScanner.stop();
      handleQrCode(decodedText);
    },
    function onFailure(error) {
      // Scan in progress, ignore frame errors
    }
  ).catch(function(err) {
    showMessage('Camera error: ' + err);
  });
}

function handleQrCode(rawText) {
  // QR codes are URLs: https://[app-url]?qr=BASE64_JSON
  // Or could be raw JSON for internally generated codes
  var payload = null;

  try {
    // Try URL format first
    if (rawText.includes('?qr=')) {
      var qrParam = rawText.split('?qr=')[1].split('&')[0];
      payload = JSON.parse(atob(qrParam));
    } else {
      // Try raw JSON
      payload = JSON.parse(rawText);
    }
  } catch (e) {
    showMessage('Invalid QR code');
    return;
  }

  if (!payload || !payload.type) {
    showMessage('Unrecognized QR code format');
    return;
  }

  switch (payload.type) {
    case 'location':
      handleLocationQr(payload);
      break;
    case 'schedule':
      handleScheduleQr(payload);
      break;
    default:
      showMessage('Unknown QR type: ' + payload.type);
  }
}
```

**Step 3: Handle location QR codes**

```javascript
function handleLocationQr(payload) {
  // Check expiration
  if (!payload.permanent && payload.expires) {
    var expiryDate = new Date(payload.expires);
    if (new Date() > expiryDate) {
      showMessage('This QR code has expired.');
      return;
    }
  }

  // Set current position
  var node = campusData.navNodes.find(function(n) {
    return n.id === payload.nodeId;
  });
  if (!node) {
    showMessage('Location not found in navigation data.');
    return;
  }

  currentStartNode = node;
  showMessage('Location set: ' + (payload.description || payload.nodeId));

  // Switch to indoor view showing this building/floor
  switchToView('indoor');
  loadFloorPlan(payload.building, payload.floor);
}
```

**Step 4: Handle schedule QR codes**

```javascript
function handleScheduleQr(payload) {
  var event = {
    id: Date.now().toString(),
    time: payload.time,
    building: payload.building,
    room: payload.room,
    name: payload.name || '',
    addedAt: new Date().toISOString()
  };

  addScheduleEvent(event);
  showMessage('Added to schedule: ' + (event.name || event.room) + ' at ' + event.time);
  switchToView('schedule');
}
```

**Step 5: Handle QR deep-links (URL ?qr= parameter)**

```javascript
function handleQrParam() {
  // Check if the app was opened via a QR code URL
  // HtmlService sandboxes the URL, so we use a workaround:
  // Pass the qr param via a template or use google.script.url
  try {
    google.script.url.getLocation(function(location) {
      var qrParam = location.parameter.qr;
      if (qrParam) {
        var payload = JSON.parse(atob(qrParam));
        handleQrCode(JSON.stringify(payload));
      }
    });
  } catch (e) {
    // google.script.url may not be available in all contexts
  }
}
```

**Step 6: Push, deploy, test**

Test by:
1. Opening the app → Scan tab → start scanner → point at a QR code
2. Creating a test QR code (use any QR generator) with JSON payload
3. Verifying location QR sets position and switches to indoor view
4. Verifying schedule QR adds event and switches to schedule view

**Step 7: Commit**

```bash
git add scripts/apps-script/WebApp.html
git commit -m "feat: integrate html5-qrcode scanner with location and schedule handling"
```

---

## Phase 7: Schedule Builder

### Task 12: Build the schedule view and event management

**Files:**
- Modify: `scripts/apps-script/WebApp.html` (Schedule view section)

**Step 1: Implement schedule localStorage management**

```javascript
function getSchedule() {
  var stored = localStorage.getItem('campusNavSchedule');
  return stored ? JSON.parse(stored) : [];
}

function saveSchedule(events) {
  localStorage.setItem('campusNavSchedule', JSON.stringify(events));
}

function addScheduleEvent(event) {
  var schedule = getSchedule();
  // Avoid duplicates (same time + building + room)
  var exists = schedule.some(function(e) {
    return e.time === event.time && e.building === event.building && e.room === event.room;
  });
  if (exists) {
    showMessage('Event already in schedule');
    return;
  }
  schedule.push(event);
  schedule.sort(function(a, b) { return a.time.localeCompare(b.time); });
  saveSchedule(schedule);
  renderSchedule();
}

function removeScheduleEvent(eventId) {
  var schedule = getSchedule().filter(function(e) { return e.id !== eventId; });
  saveSchedule(schedule);
  renderSchedule();
}
```

**Step 2: Build the timeline view**

```javascript
function renderSchedule() {
  var schedule = getSchedule();
  var container = document.getElementById('schedule-list');

  if (schedule.length === 0) {
    container.innerHTML = '<p class="empty-state">No events yet. Scan a QR code or add one manually.</p>';
    return;
  }

  var now = new Date();
  var currentTime = now.getHours().toString().padStart(2, '0') + ':' +
    now.getMinutes().toString().padStart(2, '0');

  var html = '';
  schedule.forEach(function(event) {
    var isNext = event.time >= currentTime && !event._pastNext;
    var isPast = event.time < currentTime;
    var buildingName = getBuildingName(event.building);

    html += '<div class="schedule-event' +
      (isNext ? ' next-event' : '') +
      (isPast ? ' past-event' : '') + '">';
    html += '<div class="event-time">' + event.time + '</div>';
    html += '<div class="event-details">';
    html += '<div class="event-name">' + (event.name || 'Event') + '</div>';
    html += '<div class="event-location">' + buildingName + ' - Room ' + event.room + '</div>';
    html += '</div>';
    html += '<div class="event-actions">';
    html += '<button onclick="navigateToEvent(\'' + event.building + '\',\'' + event.room + '\')">';
    html += 'Navigate</button>';
    html += '<button onclick="removeScheduleEvent(\'' + event.id + '\')" class="btn-remove">';
    html += 'Remove</button>';
    html += '</div>';
    html += '</div>';

    if (isNext) event._pastNext = true; // Only highlight first upcoming
  });

  container.innerHTML = html;
}
```

**Step 3: Add manual event creation form**

```javascript
function showAddEventForm() {
  // Show a modal/form with:
  // - Time picker input
  // - Building dropdown (from campusData.buildings)
  // - Room dropdown (filtered by selected building, from campusData.rooms)
  // - Event name text input (optional)
  // - Add button
}

function submitAddEvent(time, buildingId, roomNumber, name) {
  addScheduleEvent({
    id: Date.now().toString(),
    time: time,
    building: buildingId,
    room: roomNumber,
    name: name || '',
    addedAt: new Date().toISOString()
  });
}
```

**Step 4: Add event sharing via URL**

```javascript
function shareEvent(event) {
  var payload = {
    type: 'schedule',
    time: event.time,
    building: event.building,
    room: event.room,
    name: event.name
  };
  var encoded = btoa(JSON.stringify(payload));
  var appUrl = getConfigValue('appUrl') || window.location.href.split('?')[0];
  var shareUrl = appUrl + '?qr=' + encoded;

  // Use Web Share API if available (mobile)
  if (navigator.share) {
    navigator.share({
      title: (event.name || 'Event') + ' at ' + event.time,
      url: shareUrl
    });
  } else {
    // Copy to clipboard fallback
    navigator.clipboard.writeText(shareUrl);
    showMessage('Link copied to clipboard');
  }
}
```

**Step 5: Navigate button integration**

```javascript
function navigateToEvent(buildingId, roomNumber) {
  // Find the room and switch to indoor view
  var room = campusData.rooms.find(function(r) {
    var floor = campusData.floors.find(function(f) { return f.id === r.floorId; });
    return floor && floor.buildingId === buildingId && r.number === roomNumber;
  });

  if (room) {
    switchToView('indoor');
    var floor = campusData.floors.find(function(f) { return f.id === room.floorId; });
    loadFloorPlan(buildingId, floor.level);
    // If start position is set, automatically calculate path
    if (currentStartNode) {
      navigateToRoom(room);
    } else {
      showRoomInfo(room);
    }
  } else {
    // Room not in our indoor data — navigate to building instead
    var building = campusData.buildings.find(function(b) { return b.id === buildingId; });
    if (building && building.entrances && building.entrances[0]) {
      navigateToEntrance(building.entrances[0]);
    }
  }
}
```

**Step 6: Push, deploy, test**

Verify:
- Schedule view renders events sorted by time
- "What's next" indicator highlights correct event
- Add Event form works
- Navigate button opens indoor view for that room
- Remove button removes event
- Share button copies URL or opens share sheet

**Step 7: Commit**

```bash
git add scripts/apps-script/WebApp.html
git commit -m "feat: build schedule view with timeline, manual add, navigate, and share"
```

---

## Phase 8: Photo Pins + Pannellum

### Task 13: Integrate Pannellum panorama viewer

**Files:**
- Modify: `scripts/apps-script/WebApp.html` (add Pannellum and photo pin logic)

**Step 1: Add Pannellum library**

Load via CDN in HTML `<head>`:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.css">
<script src="https://cdn.jsdelivr.net/npm/pannellum@2.5.6/build/pannellum.js"></script>
```

**Step 2: Build the panorama modal**

```javascript
function showPanorama(photo) {
  var modal = document.getElementById('panorama-modal');
  modal.style.display = 'flex';

  pannellum.viewer('panorama-container', {
    type: 'equirectangular',
    panorama: photo.driveUrl,
    autoLoad: true,
    compass: true,
    northOffset: Number(photo.heading) || 0,
    title: photo.caption || '',
    showControls: true,
    mouseZoom: true,
    touchPanSpeedCoeffFactor: 1
  });
}

function closePanorama() {
  var modal = document.getElementById('panorama-modal');
  modal.style.display = 'none';
  document.getElementById('panorama-container').innerHTML = '';
}
```

HTML for the modal:

```html
<div id="panorama-modal" style="display:none">
  <button id="btn-close-panorama" onclick="closePanorama()">Close</button>
  <div id="panorama-container"></div>
</div>
```

**Step 3: Add indoor photo markers on floor plan canvas**

```javascript
function drawIndoorPhotoMarkers() {
  if (!currentFloor) return;
  var photos = campusData.photos.filter(function(p) {
    return p.type === 'indoor' && p.floorId === currentFloor.id;
  });

  photos.forEach(function(photo) {
    // Draw camera icon at photo position
    indoorCtx.beginPath();
    indoorCtx.arc(Number(photo.x), Number(photo.y), 8, 0, 2 * Math.PI);
    indoorCtx.fillStyle = '#FBBC04';
    indoorCtx.fill();
    indoorCtx.strokeStyle = '#F9AB00';
    indoorCtx.lineWidth = 2;
    indoorCtx.stroke();

    // Camera icon (simple circle with dot)
    indoorCtx.beginPath();
    indoorCtx.arc(Number(photo.x), Number(photo.y), 3, 0, 2 * Math.PI);
    indoorCtx.fillStyle = '#fff';
    indoorCtx.fill();
  });
}
```

Add tap detection for indoor photo markers in `handleFloorPlanTap()`:

```javascript
function handleFloorPlanTap(x, y) {
  // Check photo markers first (they're smaller, should take priority)
  var photos = campusData.photos.filter(function(p) {
    return p.type === 'indoor' && p.floorId === currentFloor.id;
  });
  for (var i = 0; i < photos.length; i++) {
    var dx = x - Number(photos[i].x);
    var dy = y - Number(photos[i].y);
    if (dx * dx + dy * dy < 144) { // 12px radius
      showPanorama(photos[i]);
      return;
    }
  }

  // Then check rooms
  // ... existing room tap logic ...
}
```

**Step 4: Drive URL handling for panorama images**

Google Drive share links need to be converted to direct download URLs for Pannellum:

```javascript
function getDriveDirectUrl(driveUrl) {
  // Convert: https://drive.google.com/file/d/FILE_ID/view?usp=sharing
  // To:      https://drive.google.com/uc?export=view&id=FILE_ID
  var match = driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) {
    return 'https://drive.google.com/uc?export=view&id=' + match[1];
  }
  return driveUrl; // Already a direct URL
}
```

Use this in `showPanorama()`:

```javascript
panorama: getDriveDirectUrl(photo.driveUrl),
```

**Step 5: Push, deploy, test**

Test by:
1. Uploading a test panorama image to Google Drive
2. Adding a row to the Photos sheet with the Drive share URL
3. Verifying the photo marker appears on the map/floor plan
4. Tapping the marker and seeing Pannellum load the panorama

**Step 6: Commit**

```bash
git add scripts/apps-script/WebApp.html
git commit -m "feat: integrate Pannellum panorama viewer with indoor and outdoor photo pins"
```

---

## Phase 9: Admin Tools

### Task 14: Build QR code generator (admin page)

**Files:**
- Create: `scripts/apps-script/Admin.html`
- Modify: `scripts/apps-script/Code.gs` (add admin route)
- Create: `scripts/apps-script/AdminAPI.gs` (admin data operations)

**Step 1: Add admin route to Code.gs**

Add to the `doGet()` function, before the default web app return:

```javascript
if (action === 'admin') {
  return HtmlService.createHtmlOutputFromFile('Admin')
    .setTitle('Campus Nav Admin')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
```

**Step 2: Write AdminAPI.gs**

```javascript
/**
 * AdminAPI.gs — Admin operations for managing campus data.
 */

/**
 * Saves a new QR location to the QRLocations sheet.
 */
function saveQrLocation(data) {
  var ss = _getSpreadsheet();
  var sheet = ss.getSheetByName('QRLocations');
  var id = 'qrloc-' + Date.now();
  sheet.appendRow([
    id,
    data.buildingId,
    data.floorId,
    data.nodeId,
    data.description,
    data.permanent ? 'TRUE' : 'FALSE',
    data.expires || '',
    new Date().toISOString()
  ]);

  // Increment data version so clients refresh
  _incrementDataVersion(ss);

  return { id: id };
}

/**
 * Increments the dataVersion in Config sheet.
 */
function _incrementDataVersion(ss) {
  var configSheet = ss.getSheetByName('Config');
  var data = configSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === 'dataVersion') {
      var newVersion = (parseInt(data[i][1]) || 0) + 1;
      configSheet.getRange(i + 1, 2).setValue(String(newVersion));
      return;
    }
  }
}
```

**Step 3: Build Admin.html**

The admin page includes:
- **Location QR Generator:**
  - Building selector → Floor selector → tap on floor plan canvas to pick position
  - Node ID field, description field
  - Permanent toggle / expiration date picker
  - "Generate QR" button → shows QR code image (using QR code generation library)
  - "Generate Batch" → generate multiple codes, download as printable page

- **Schedule QR Generator:**
  - Time, building, room, event name fields
  - "Generate QR" button

- Use a client-side QR generation library (e.g., `qrcode.js` via CDN) to render QR codes:

```html
<script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script>
```

```javascript
function generateLocationQr(data) {
  var payload = {
    type: 'location',
    building: data.buildingId,
    floor: data.floorLevel,
    nodeId: data.nodeId,
    permanent: data.permanent,
    expires: data.expires,
    description: data.description
  };

  var appUrl = ''; // Set from DEPLOYMENT.md
  var encoded = btoa(JSON.stringify(payload));
  var qrUrl = appUrl + '?qr=' + encoded;

  var container = document.getElementById('qr-output');
  container.innerHTML = '';
  new QRCode(container, {
    text: qrUrl,
    width: 256,
    height: 256
  });

  // Show print button
  document.getElementById('btn-print-qr').style.display = 'block';

  // Save to sheet
  google.script.run
    .withSuccessHandler(function(result) {
      showMessage('QR location saved: ' + result.id);
    })
    .saveQrLocation(data);
}

function generateScheduleQr(data) {
  var payload = {
    type: 'schedule',
    time: data.time,
    building: data.buildingId,
    room: data.room,
    name: data.name
  };

  var appUrl = '';
  var encoded = btoa(JSON.stringify(payload));
  var qrUrl = appUrl + '?qr=' + encoded;

  var container = document.getElementById('qr-output');
  container.innerHTML = '';
  new QRCode(container, {
    text: qrUrl,
    width: 256,
    height: 256
  });
}
```

**Step 4: Batch QR generation with printable layout**

```javascript
function generateBatchQr(locations) {
  var printContainer = document.getElementById('batch-print');
  printContainer.innerHTML = '';

  locations.forEach(function(loc) {
    var payload = {
      type: 'location',
      building: loc.buildingId,
      floor: loc.floorLevel,
      nodeId: loc.nodeId,
      permanent: loc.permanent,
      expires: loc.expires
    };
    var encoded = btoa(JSON.stringify(payload));
    var qrUrl = appUrl + '?qr=' + encoded;

    var card = document.createElement('div');
    card.className = 'qr-print-card';
    card.innerHTML = '<div class="qr-image" id="qr-' + loc.nodeId + '"></div>' +
      '<div class="qr-label">' + loc.description + '</div>';
    printContainer.appendChild(card);

    new QRCode(document.getElementById('qr-' + loc.nodeId), {
      text: qrUrl, width: 200, height: 200
    });
  });

  // Print CSS: arrange cards in a grid, each ~3x3 inches
  window.print();
}
```

**Step 5: Push, deploy, test**

Access admin page at `DEPLOYMENT_URL?action=admin`. Test:
- Generate a location QR code → scan it with the main app → verify position is set
- Generate a schedule QR code → scan it → verify event is added
- Verify QR locations are saved to the sheet

**Step 6: Commit**

```bash
git add scripts/apps-script/Admin.html scripts/apps-script/AdminAPI.gs scripts/apps-script/Code.gs
git commit -m "feat: build admin page with QR code generator (location + schedule)"
```

---

## Phase 10: Floor Plan Digitization (Parallel Workstream)

> **This phase runs in parallel with the coding phases above.** It is a data preparation task, not a coding task. It produces the actual building data that populates the Google Sheet.

### Task 15: Convert PDF floor plans to PNG images

**Goal:** Produce clean, high-resolution PNG images of each floor for each building.

**Steps:**

1. Open each scanned PDF floor plan
2. Export/screenshot at high resolution (at least 2000px wide)
3. Crop to just the floor plan area (remove title blocks, margins)
4. Save as PNG with descriptive names: `eng1-floor1.png`, `eng1-floor2.png`, etc.
5. Upload PNGs to a Google Drive folder
6. Set sharing to "Anyone with the link can view"
7. Record the Drive share URLs in the Floors sheet

**Tools:** Any image editor (GIMP, Paint.NET, Photoshop) or PDF tool (Adobe Acrobat, pdf2image Python library)

---

### Task 16: Digitize room boundaries and labels

**Goal:** Create room polygon data and room labels for each floor.

**Steps:**

1. Open each floor plan PNG in a polygon drawing tool. Options:
   - **geojson.io** — draw polygons over the image, export as GeoJSON
   - **Custom admin tool** (we could build a simple canvas-based polygon editor into Admin.html)
   - **GIMP/Inkscape** — trace room outlines, export coordinates
2. For each room:
   - Trace the room boundary as a polygon (series of [x,y] pixel coordinates)
   - Record the room number (from the floor plan labels or OCR)
   - Calculate center point (average of polygon vertices)
3. Enter data into the Rooms sheet:
   - `id`: e.g., `eng1-f1-101`
   - `floorId`: matches the Floors sheet
   - `number`: room number from floor plan
   - `polygon`: JSON array of [x,y] coordinates
   - `centerX`, `centerY`: center of the polygon

**Estimate:** 30-50 rooms per floor, ~1-2 hours per floor with a polygon tool.

---

### Task 17: Build navigation graphs

**Goal:** Create the node-and-edge graph that A* uses for indoor pathfinding.

**Steps:**

1. On each floor plan, identify and place nodes at:
   - Every room door (type: `room`, linked to roomId)
   - Every hallway intersection (type: `hallway`)
   - Every staircase landing (type: `staircase`)
   - Every elevator (type: `elevator`)
   - Every building entrance (type: `entrance`)
2. For each pair of connected nodes, create an edge:
   - Measure pixel distance between the two nodes
   - Mark `floorChange: TRUE` for edges connecting staircase/elevator nodes across floors
3. Enter data into NavNodes and NavEdges sheets

**Cross-floor connections:**
- A staircase node on Floor 1 connects via an edge to the staircase node on Floor 2
- Mark these edges with `floorChange: TRUE`
- The A* algorithm handles floor transitions automatically

**Estimate:** 50-100 nodes per floor, ~1-2 hours per floor.

---

### Task 18: Populate building entrance GPS coordinates

**Goal:** Get precise GPS coordinates for every building entrance.

**Steps:**

1. Visit each building entrance in person with a phone
2. Use Google Maps "drop a pin" or a GPS app to get lat/lng
3. Update the Buildings sheet `entrances` JSON with accurate coordinates
4. Take panorama photos at each entrance for the Photos sheet

---

## Phase 11: Polish and Integration Testing

### Task 19: Style the app for mobile

**Files:**
- Modify: `scripts/apps-script/WebApp.html` (CSS)

**Step 1: Add comprehensive mobile CSS**

Key styling requirements:
- Full viewport height, no overflow scrolling on main container
- Bottom nav: fixed, 56px height, icons + labels, active tab highlighted
- Info panels: slide up from bottom (bottom sheet pattern)
- Loading states: skeleton screens or spinners
- Color scheme: Murray State blue/gold or neutral engineering theme
- Touch targets: minimum 44px
- Font sizing: 16px base (prevents iOS zoom on input focus)
- Dark mode support via `prefers-color-scheme` media query

**Step 2: Add Murray State School of Engineering branding**

- App title in the header/loading screen
- Subtle branding, not overpowering — this is a utility app

**Step 3: Push, deploy, test on actual phone**

Test on both iOS Safari and Android Chrome. Verify:
- All views render correctly
- Touch interactions (pan/zoom/tap) work smoothly
- Bottom nav doesn't overlap content
- Camera permission prompt works for QR scanner

**Step 4: Commit**

```bash
git add scripts/apps-script/WebApp.html
git commit -m "feat: add mobile-first responsive styling with Murray State branding"
```

---

### Task 20: End-to-end integration test

**Goal:** Test the complete user flow with real(ish) data.

**Test flow 1: Student arriving on campus**
1. Open the app URL on phone
2. See campus map with building markers
3. Tap an engineering building → see entrances
4. Tap "Navigate" → Google Maps opens with walking directions
5. Arrive at building entrance

**Test flow 2: Entering a building with QR code**
1. Scan a location QR code at the entrance
2. App sets position and switches to indoor view
3. See floor plan with rooms highlighted
4. Tap a room → tap "Navigate Here"
5. See navigation path drawn on floor plan
6. If destination is on different floor, see floor change instructions

**Test flow 3: Schedule workflow**
1. Scan a schedule QR code
2. Event appears in schedule timeline
3. Tap "Navigate" on the event
4. App switches to indoor view with route to that room

**Test flow 4: Photo pins**
1. On the campus map, tap a photo pin
2. Panorama viewer opens
3. Can look around the panorama
4. Close viewer

**Test flow 5: Admin QR generation**
1. Open admin page
2. Generate a location QR code
3. Print it
4. Scan it with the main app → verify position is set correctly

---

## Task Dependency Summary

```
Phase 1 (Scaffold)     → Phase 2 (Data Model)     → Phase 3 (Map + Shell)
                                                     → Phase 4 (Floor Plan Viewer)
                                                       → Phase 5 (Pathfinding)
                                                         → Phase 6 (QR System)
                                                           → Phase 7 (Schedule)
Phase 3                                              → Phase 8 (Photo Pins)
Phase 5 + Phase 6                                    → Phase 9 (Admin Tools)
                                                     → Phase 11 (Polish + Testing)

Phase 10 (Digitization) runs in PARALLEL with all coding phases.
```

**Critical path for EDay:** Phases 1→2→3→4→5→6→7 (this gets the core nav + schedule working)
Phases 8, 9, 10 can run in parallel with later phases.
Phase 10 (digitization) should start immediately since it's manual work.
