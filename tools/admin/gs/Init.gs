/**
 * Init.gs — Sheet creation, schema (data contract v2) and seeding for Murray
 * State Campus Navigation. Since v3 the "sheet" is the in-memory one of the
 * Apps Script stand-in (dev/gas-runtime.cjs), seeded fresh on every export and
 * every local admin start; operator edits live in data/overrides.
 *
 * Naming: helpers end with an underscore so google.script.run cannot call them
 * (Apps Script hides only trailing-underscore functions from the client).
 */

/**
 * Creates the backing sheet if it does not exist, ensures every tab has the v2
 * headers and text formats, and seeds empty tabs. Idempotent.
 *
 * @return {Object} { initialized, created, url, seeded, counts, schemaMismatch, floorSeedSource }
 */
function initSystem() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var props = PropertiesService.getScriptProperties();
    var sheetId = props.getProperty('SHEET_ID');
    var ss = null;
    var created = false;

    if (sheetId) {
      try {
        ss = SpreadsheetApp.openById(sheetId);
      } catch (e) {
        ss = null;
        props.deleteProperty('SHEET_ID');
      }
    }

    if (!ss) {
      ss = SpreadsheetApp.create('Murray State Campus Nav - Data');
      props.setProperty('SHEET_ID', ss.getId());
      created = true;
    }

    var mismatch = ensureAllSheets_(ss);
    seedConfig_(ss);
    var seeded = seedAllCampusData(ss);

    return {
      initialized: true,
      created: created,
      url: ss.getUrl(),
      seeded: seeded,
      counts: countRows_(ss),
      schemaMismatch: mismatch,
      floorSeedSource: floorSeedSource_()
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Data contract v2. Every lane reads these shapes. v4 additions (columns appended, so older rows stay valid):
 * Buildings.levels / Buildings.height (extrusion on the campus map; seeded by the campus-map build, overridable) and
 * NavNodes.primary (an entrance visitors are routed to; seeded by the primary-entrance heuristic, overridable).
 * v5: Rooms.access and NavNodes.access, "main" | "alt" | "emergency" (doors, entrances, waypoints and corridor rooms;
 * blank elsewhere), seeded by the pipeline and the campus-map build, overridable. NavNodes.primary is retired (v5
 * integration: the column is gone); an old primary override reads as access (true main, false alt;
 * scripts/data/overrides.mjs).
 *  - appended: columns added after the generated seed's format; a seed row without them is padded with blanks.
 *  - text:  columns forced to plain-text format so Sheets keeps "0141" as "0141".
 *  - json:  columns stored as JSON strings and parsed on read.
 *  - bools: boolean columns with the default used when a cell is blank.
 */
function getSheetDefinitions_() {
  return [
    { name: 'Config', headers: ['key', 'value'], text: ['key', 'value'] },
    {
      name: 'Buildings',
      headers: ['id', 'name', 'code', 'number', 'lat', 'lng', 'entrances', 'photoUrl', 'hasIndoor', 'levels', 'height'],
      text: ['id', 'name', 'code', 'number', 'photoUrl'],
      json: ['entrances'],
      bools: { hasIndoor: false }
    },
    {
      name: 'Floors',
      headers: ['id', 'buildingId', 'level', 'label', 'planAsset', 'widthPx', 'heightPx', 'metersPerPixel', 'public'],
      text: ['id', 'buildingId', 'label', 'planAsset'],
      bools: { 'public': true }
    },
    {
      name: 'Rooms',
      headers: ['id', 'floorId', 'number', 'label', 'type', 'polygon', 'centerX', 'centerY', 'searchable', 'access'],
      text: ['id', 'floorId', 'number', 'label', 'type', 'access'],
      json: ['polygon'],
      bools: { searchable: true },
      appended: ['access']
    },
    {
      name: 'NavNodes',
      headers: ['id', 'floorId', 'x', 'y', 'type', 'roomId', 'linkId', 'access'],
      text: ['id', 'floorId', 'type', 'roomId', 'linkId', 'access'],
      appended: ['access']
    },
    {
      name: 'NavEdges',
      headers: ['id', 'fromNodeId', 'toNodeId', 'distance', 'floorChange', 'accessible'],
      text: ['id', 'fromNodeId', 'toNodeId'],
      bools: { floorChange: false, accessible: true }
    },
    {
      name: 'Photos',
      headers: ['id', 'type', 'buildingId', 'floorId', 'x', 'y', 'lat', 'lng', 'driveUrl', 'caption', 'heading'],
      text: ['id', 'type', 'buildingId', 'floorId', 'driveUrl', 'caption']
    },
    {
      name: 'QRLocations',
      headers: ['id', 'buildingId', 'floorId', 'nodeId', 'description', 'permanent', 'expires', 'createdDate'],
      text: ['id', 'buildingId', 'floorId', 'nodeId', 'description', 'expires', 'createdDate'],
      bools: { permanent: false }
    }
  ];
}

/** @return {Object|null} The definition for one tab. */
function getSheetDefinition_(name) {
  var defs = getSheetDefinitions_();
  for (var i = 0; i < defs.length; i++) {
    if (defs[i].name === name) return defs[i];
  }
  return null;
}

/**
 * Creates missing tabs with v2 headers, applies text formats, removes an empty
 * default "Sheet1". Does not rewrite existing headers.
 * @return {Array} Names of tabs whose existing header row differs from v2.
 */
function ensureAllSheets_(ss) {
  var defs = getSheetDefinitions_();
  var mismatch = [];
  for (var d = 0; d < defs.length; d++) {
    var def = defs[d];
    var sheet = ss.getSheetByName(def.name);
    if (!sheet) {
      sheet = ss.insertSheet(def.name);
      sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    } else {
      var width = Math.max(sheet.getLastColumn(), 1);
      var current = sheet.getRange(1, 1, 1, width).getValues()[0];
      if (current.slice(0, def.headers.length).join('|') !== def.headers.join('|') || width > def.headers.length) {
        mismatch.push(def.name);
      }
    }
    applyTextFormats_(sheet, def);
  }

  var defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && defaultSheet.getLastRow() <= 1 && defaultSheet.getLastColumn() <= 1 && ss.getSheets().length > 1) {
    ss.deleteSheet(defaultSheet);
  }
  return mismatch;
}

/** Forces plain-text number format on a tab's text columns (data rows). */
function applyTextFormats_(sheet, def) {
  if (!def.text) return;
  var rows = Math.max(sheet.getMaxRows() - 1, 1);
  for (var i = 0; i < def.text.length; i++) {
    var col = def.headers.indexOf(def.text[i]);
    if (col !== -1) {
      sheet.getRange(2, col + 1, rows, 1).setNumberFormat('@');
    }
  }
}

/**
 * Seeds the Config tab: dataVersion, routing.altFactor (v5: an alt door, hallway or path costs its length times this)
 * and the v5.1 route weights in meters (scripts/data/access.mjs ROUTING_WEIGHTS: per side door, indoor turn, floor
 * change, hallway junction and room walked through); data/overrides/config.json may change them.
 * No secrets ever live in seed code.
 */
function seedConfig_(ss) {
  var configSheet = ss.getSheetByName('Config');
  if (configSheet && configSheet.getLastRow() <= 1) {
    configSheet.getRange(2, 1, 7, 2).setValues([['dataVersion', '1'], ['routing.altFactor', '3'], ['routing.sideDoorCost', '300'],
      ['routing.turnCost', '15'], ['routing.floorChangeCost', '120'], ['routing.junctionCost', '8'], ['routing.roomCost', '15']]);
  }
}

/** @return {Object} Data-row count per tab. */
function countRows_(ss) {
  var defs = getSheetDefinitions_();
  var counts = {};
  for (var i = 0; i < defs.length; i++) {
    var sheet = ss.getSheetByName(defs[i].name);
    counts[defs[i].name] = sheet ? Math.max(sheet.getLastRow() - 1, 0) : 0;
  }
  return counts;
}
