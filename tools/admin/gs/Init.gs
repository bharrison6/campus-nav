/**
 * Init.gs — Sheet creation, schema (data contract v2), seeding, and the
 * first-run ADMIN_PIN bootstrap for Murray State Campus Navigation.
 *
 * Naming: helpers end with an underscore so google.script.run cannot call them
 * (Apps Script hides only trailing-underscore functions from the client).
 */

/**
 * Creates the backing Google Sheet if it does not exist, ensures every tab has
 * the v2 headers and text formats, seeds empty tabs, and generates an
 * ADMIN_PIN in Script Properties on first run.
 *
 * Idempotent: safe to call repeatedly. Never returns a secret value; the
 * operator reads ADMIN_PIN in the Apps Script editor (Project Settings >
 * Script Properties).
 *
 * @return {Object} { initialized, created, url, seeded, counts, schemaMismatch, floorSeedSource, settings }
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
    ensureAdminPin_();

    return {
      initialized: true,
      created: created,
      url: ss.getUrl(),
      seeded: seeded,
      counts: countRows_(ss),
      schemaMismatch: mismatch,
      floorSeedSource: floorSeedSource_(),
      settings: settingsStatus_()
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Data contract v2. Every lane reads these shapes.
 *  - text:  columns forced to plain-text format so Sheets keeps "0141" as "0141".
 *  - json:  columns stored as JSON strings and parsed on read.
 *  - bools: boolean columns with the default used when a cell is blank.
 */
function getSheetDefinitions_() {
  return [
    { name: 'Config', headers: ['key', 'value'], text: ['key', 'value'] },
    {
      name: 'Buildings',
      headers: ['id', 'name', 'code', 'number', 'lat', 'lng', 'entrances', 'photoUrl', 'hasIndoor'],
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
      headers: ['id', 'floorId', 'number', 'label', 'type', 'polygon', 'centerX', 'centerY', 'searchable'],
      text: ['id', 'floorId', 'number', 'label', 'type'],
      json: ['polygon'],
      bools: { searchable: true }
    },
    {
      name: 'NavNodes',
      headers: ['id', 'floorId', 'x', 'y', 'type', 'roomId', 'linkId'],
      text: ['id', 'floorId', 'type', 'roomId', 'linkId']
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

/** Seeds the Config tab (dataVersion only; no secrets ever live in seed code). */
function seedConfig_(ss) {
  var configSheet = ss.getSheetByName('Config');
  if (configSheet && configSheet.getLastRow() <= 1) {
    configSheet.getRange(2, 1, 1, 2).setValues([['dataVersion', '1']]);
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

/**
 * Generates a random 6-digit ADMIN_PIN into Script Properties when none exists.
 * Returns only whether it generated one; the value never leaves the property store.
 * @return {boolean}
 */
function ensureAdminPin_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('ADMIN_PIN')) return false;
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + ':' + Utilities.getUuid() + ':' + new Date().getTime()
  );
  var n = 0;
  for (var i = 0; i < 6; i++) {
    n = (n * 256 + (digest[i] & 255)) % 900000;
  }
  props.setProperty('ADMIN_PIN', String(100000 + n));
  return true;
}
