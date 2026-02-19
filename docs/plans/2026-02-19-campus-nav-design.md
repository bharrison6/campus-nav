# Murray State Campus Navigation — Design Document

**Date:** 2026-02-19
**Status:** Approved
**Branding:** Murray State School of Engineering (not EDay-specific)

---

## Purpose

A campus navigation web app for Murray State University that enables students, faculty, and visitors to:

1. Navigate between buildings using walking directions
2. Navigate inside buildings (room-to-room) using digitized floor plans
3. View panoramic photos of campus locations
4. Build a personal schedule of places/times with QR-code-based import
5. Scan QR codes posted in buildings to determine current location

The app is initially built for EDay but is designed as a general-purpose campus navigation tool.

---

## System Architecture

**Platform:** Google Apps Script web app served via HtmlService, backed by Google Sheets.

```
Google Apps Script Web App
  Code.gs ── doGet() router
    ├── ?action=web  → HtmlService (main app)
    ├── ?action=init → Init.gs (setup sheets)
    └── ?action=*    → API.gs (data endpoints)

  WebApp.html ── Single-page application
    ├── Campus Map (Google Maps Embed/JS API)
    ├── Indoor Navigation (Canvas floor plans)
    ├── QR Scanner (html5-qrcode library)
    ├── Schedule Builder (localStorage)
    └── Photo Viewer (Pannellum)

  Google Sheets (data store)
    ├── Buildings, Floors, Rooms
    ├── NavNodes, NavEdges
    ├── Photos, QRLocations
    └── Config (version tracking)
```

**Data flow:**
- On first load, app fetches all campus data via `google.script.run.getAllCampusData()` and caches in `localStorage`
- Subsequent interactions use cached data (no further server calls unless data version changes)
- Schedule events stored in `localStorage` (no user accounts)
- Admin operations (data updates) happen directly in Sheets or via admin API endpoints

---

## Feature 1: Campus Map + Outdoor Navigation

**Campus Map View (main screen):**
- Full-screen Google Map centered on Murray State campus
- Custom markers for each building (from Buildings sheet)
- Tapping a building shows: name, available entrances, "Navigate here" button
- Buildings with floor plans also show "View inside" button

**Walking Directions:**
- Uses Google Maps Embed API (free, unlimited) to show walking route
- From student's current GPS location to a selected building entrance
- Multi-entrance buildings let student pick which entrance (some buildings have ground + upper-floor entrances)
- Each entrance stored as GPS coordinates in the Buildings sheet
- Fallback: deep-link to native Google Maps (`https://maps.google.com/?saddr=current&daddr=LAT,LNG&dirflg=w`)

**Campus walkway handling:**
- Verify early whether Google Maps has Murray State's pedestrian paths
- If paths missing: show destination pin so students navigate visually, add note "Follow campus walkways"
- Long-term: contribute walkway data to OpenStreetMap

---

## Feature 2: Indoor Navigation

### Floor Plan Digitization (one-time setup per building)

1. Convert scanned PDF floor plans to high-res PNG images (one per floor)
2. Manually trace room boundaries as polygons, label room numbers
3. Build navigation graph per floor:
   - **Nodes:** room doors, hallway intersections, staircase landings, elevators, building entrances
   - **Edges:** walkable connections between nodes with pixel-distance weights
   - Staircase/elevator nodes connect across floors
4. Store in Sheets: room polygons (JSON coordinate arrays), room labels, nav graph (node + edge lists)

### Indoor Navigation View

- Student taps "View inside" on a building → floor plan rendered on HTML Canvas
- Floor selector buttons to switch levels
- Rooms are tappable highlighted regions on the floor plan
- Tapping a room shows number and "Navigate here" button

### Pathfinding

- **A* algorithm** on the nav graph, runs entirely client-side in JavaScript
- Input: start node (from QR scan or manual entrance selection) → destination room node
- Output: ordered list of nodes forming shortest path
- Multi-floor routes: path → nearest staircase/elevator → floor change → destination
- Path drawn as colored line overlaid on floor plan canvas
- Floor transitions show prompt: "Go to Floor 2 via East Stairwell"

### QR Location Codes ("You Are Here")

- Physical QR codes posted at strategic building locations
- Payload: `{ "type": "location", "building": "ENG1", "floor": 1, "nodeId": "entrance-north", "expires": "2026-03-05", "permanent": false }`
- Student scans QR → app sets position → student selects destination → path calculated
- Without QR: student manually selects entrance from a list
- **Expiration system:** QR codes are either permanent (building entrances, stairwells) or temporary with an expiration date (event-specific placements). App rejects expired codes.
- Admin generates, prints, and physically places QR codes. Temporary codes are removed after the event.

---

## Feature 3: Photo Pins (Panoramas)

- Admin captures panorama photos at key campus locations using phone panorama mode
- Photos uploaded to Google Drive folder, registered in Photos sheet
- On campus map: camera icons at outdoor photo locations
- On indoor floor plans: camera icons at indoor photo locations
- Tapping a photo pin opens **Pannellum** panorama viewer in a modal overlay
- Pannellum: open-source JS viewer (~21KB), handles both full 360 and partial phone panoramas, loaded via CDN
- Especially useful at building entrances: "Is this the right door?"

---

## Feature 4: Schedule Builder

### Schedule QR Codes

- Payload: `{ "type": "schedule", "time": "09:00", "building": "ENG1", "room": "201", "name": "Intro to Robotics" }`
- Generated by the separate EDay app (or by our app's admin tools)
- QR codes hold thousands of characters — event name fits easily
- Zero data sync between the two apps

### Schedule View

- Chronological timeline: time, event name, building + room
- Each event has "Navigate" button → jumps to indoor navigation for that room
- "What's next" indicator highlights upcoming event based on current time
- Students can remove events from their schedule

### Manual Event Creation

- "Add Event" form: time picker, building dropdown, room dropdown (filtered by building), optional name field

### Sharing

- Schedule events can be shared as URLs with QR payload encoded as query parameter
- Recipients open the link → app parses payload → event added to their schedule
- Non-QR fallback for sharing via text/email

---

## Feature 5: QR Code Generator (Admin)

### Location QR Codes

- Admin opens admin view → selects building → selects floor → taps position on floor plan
- Enters: node ID, description ("East stairwell, 2nd floor landing")
- Selects: permanent or temporary with expiration date
- App generates printable QR code, updates QRLocations sheet
- Batch generation: multiple QR codes at once, downloadable as printable PDF

### Schedule QR Codes

- Admin enters: time, building, room, event name
- App generates QR code with schedule payload
- Can be printed, emailed, or displayed on screen

### QR Code Format

- All QR codes encode a URL: `https://[app-url]?qr=BASE64_ENCODED_JSON`
- Works when scanned by any QR reader (opens the app URL) or by our built-in scanner (processes directly)
- Dual-path ensures QR codes work with phone's default camera or the in-app scanner

---

## Data Model (Google Sheets)

| Sheet | Columns | Purpose |
|-------|---------|---------|
| **Config** | key, value | App version number, settings |
| **Buildings** | id, name, lat, lng, entrances (JSON: [{name, lat, lng, nodeId}]), photoUrl | All campus buildings |
| **Floors** | id, buildingId, level, label, planImageUrl, widthPx, heightPx, metersPerPixel | Floor plan metadata |
| **Rooms** | id, floorId, number, label, polygon (JSON: [[x,y],...]), centerX, centerY | Room positions on floor plans |
| **NavNodes** | id, floorId, x, y, type (room/hallway/staircase/elevator/entrance), roomId | Navigation graph nodes |
| **NavEdges** | id, fromNodeId, toNodeId, distance, floorChange | Walkable connections |
| **Photos** | id, type (outdoor/indoor), buildingId, floorId, x, y, lat, lng, driveUrl, caption, heading | Photo pin locations |
| **QRLocations** | id, buildingId, floorId, nodeId, description, permanent, expires, createdDate | Registered location QR codes |

**Data loading strategy:**
- All data fetched on app load via `google.script.run.getAllCampusData()`
- Cached in `localStorage` with a version stamp
- Client checks Config sheet version on each load — only re-fetches if version changed
- Schedule events are purely client-side `localStorage` (never sent to server)

---

## Initial Scope (EDay v1)

**Two engineering buildings** with:
- Digitized floor plans (all floors)
- Navigation graphs (room-to-room pathfinding)
- Building entrance GPS coordinates
- Location QR codes at entrances and key interior points
- Panorama photos at entrances

**Campus-wide:**
- Building markers for all campus buildings on the map (outdoor nav to any building)
- Walking directions between any two points on campus

**Schedule system** ready for EDay QR code integration.

---

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Backend | Google Apps Script (V8 runtime) |
| Data store | Google Sheets |
| Frontend | HTML/CSS/JavaScript (single page, served by HtmlService) |
| Maps | Google Maps Embed API (free) or Maps JavaScript API |
| Indoor maps | HTML Canvas with custom rendering |
| Pathfinding | A* algorithm (client-side JS) |
| QR scanning | html5-qrcode library |
| Panorama viewer | Pannellum (CDN) |
| Photo hosting | Google Drive |
| Deploy toolchain | clasp v3 |

---

## Future Enhancements (Post-EDay)

- Additional buildings as floor plans are digitized
- Contribute campus walkway data to OpenStreetMap
- Upgrade to 360 camera for true spherical panoramas
- Accessibility features (wheelchair-accessible route option using elevator-only paths)
- Event discovery (browse upcoming events by building/time)
- Real-time crowd info or wait times at event locations
