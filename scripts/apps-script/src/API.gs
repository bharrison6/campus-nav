/**
 * API.gs — Read-side data access (contract v2) and the settings read helpers.
 */

function getDataVersion() {
  var ss = getSpreadsheet_();
  var data = ss.getSheetByName('Config').getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === 'dataVersion') {
      return String(data[i][1]);
    }
  }
  return '0';
}

/**
 * Everything, every floor and room (admin and any client that wants all data).
 * config is an array of { key, value }. A resolved mapsApiKey entry is added
 * when a key is configured (Script Property first, Config sheet fallback):
 * it is a browser key that Maps JavaScript needs on the client, so it is the
 * one stored setting that does reach clients. ADMIN_PIN and SHEET_ID never do.
 */
function getAllCampusData() {
  return buildCampusPayload_(getSpreadsheet_());
}

/**
 * The public web app's payload: the same shapes as getAllCampusData without
 * non-public floors (floors with public = false) and everything on them
 * (rooms, nav nodes, edges touching those nodes, indoor photos, QR locations).
 * Non-searchable rooms are kept: they are still drawn and tappable on the
 * floor plan; clients exclude them from search via the searchable flag.
 */
function getPublicCampusData() {
  return filterPublic_(buildCampusPayload_(getSpreadsheet_()));
}

/**
 * Payload measurements for the full and public variants (counts and JSON bytes).
 * Used to decide whether further trimming is needed.
 */
function getCampusDataStats() {
  var all = buildCampusPayload_(getSpreadsheet_());
  var pub = filterPublic_(all);
  return {
    version: all.version,
    full: payloadStats_(all),
    'public': payloadStats_(pub)
  };
}

function buildCampusPayload_(ss) {
  var config = sheetToObjects_(ss, 'Config');
  var publicConfig = [];
  var version = '0';
  for (var i = 0; i < config.length; i++) {
    if (config[i].key === 'dataVersion') version = String(config[i].value);
    if (config[i].key !== 'mapsApiKey') publicConfig.push(config[i]);
  }
  var key = getMapsApiKey_(config);
  if (key) publicConfig.push({ key: 'mapsApiKey', value: key });

  return {
    contractVersion: 2,
    version: version,
    config: publicConfig,
    buildings: sheetToObjects_(ss, 'Buildings'),
    floors: sheetToObjects_(ss, 'Floors'),
    rooms: sheetToObjects_(ss, 'Rooms'),
    navNodes: sheetToObjects_(ss, 'NavNodes'),
    navEdges: sheetToObjects_(ss, 'NavEdges'),
    photos: sheetToObjects_(ss, 'Photos'),
    qrLocations: sheetToObjects_(ss, 'QRLocations')
  };
}

function filterPublic_(all) {
  var hiddenFloors = {};
  var floors = [];
  for (var f = 0; f < all.floors.length; f++) {
    if (all.floors[f]['public'] === false) {
      hiddenFloors[all.floors[f].id] = true;
    } else {
      floors.push(all.floors[f]);
    }
  }
  var keepByFloor = function (rows) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      if (!hiddenFloors[rows[i].floorId]) out.push(rows[i]);
    }
    return out;
  };
  var hiddenNodes = {};
  for (var h = 0; h < all.navNodes.length; h++) {
    if (hiddenFloors[all.navNodes[h].floorId]) hiddenNodes[all.navNodes[h].id] = true;
  }
  var navEdges = [];
  for (var e = 0; e < all.navEdges.length; e++) {
    var edge = all.navEdges[e];
    if (!hiddenNodes[edge.fromNodeId] && !hiddenNodes[edge.toNodeId]) navEdges.push(edge);
  }
  return {
    contractVersion: all.contractVersion,
    version: all.version,
    config: all.config,
    buildings: all.buildings,
    floors: floors,
    rooms: keepByFloor(all.rooms),
    navNodes: keepByFloor(all.navNodes),
    navEdges: navEdges,
    photos: keepByFloor(all.photos),
    qrLocations: keepByFloor(all.qrLocations)
  };
}

function payloadStats_(p) {
  var counts = {};
  var names = ['buildings', 'floors', 'rooms', 'navNodes', 'navEdges', 'photos', 'qrLocations'];
  for (var i = 0; i < names.length; i++) counts[names[i]] = p[names[i]].length;
  return { counts: counts, jsonBytes: Utilities.newBlob(JSON.stringify(p)).getBytes().length };
}

/**
 * Reads one tab into objects keyed by header. JSON columns are parsed, boolean
 * columns normalized (blank uses the contract default), Dates become ISO
 * strings (google.script.run cannot return Date objects).
 */
function sheetToObjects_(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var def = getSheetDefinition_(sheetName) || {};
  var json = def.json || [];
  var bools = def.bools || {};

  var headers = data[0];
  var results = [];
  for (var r = 1; r < data.length; r++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      var h = headers[c];
      if (!h) continue;
      var val = data[r][c];
      if (val instanceof Date) {
        val = val.toISOString();
      } else if (json.indexOf(h) !== -1) {
        if (typeof val === 'string' && val.length > 0) {
          try { val = JSON.parse(val); } catch (e) { /* keep as string */ }
        }
      } else if (bools.hasOwnProperty(h)) {
        val = toBool_(val, bools[h]);
      }
      obj[h] = val;
    }
    results.push(obj);
  }
  return results;
}

/**
 * The Maps browser key: Script Property mapsApiKey first, Config sheet row
 * mapsApiKey only when the property is absent. Pass already-read Config
 * objects to avoid a re-read.
 */
function getMapsApiKey_(configObjects) {
  var key = PropertiesService.getScriptProperties().getProperty('mapsApiKey');
  if (key) return key;
  var config = configObjects;
  if (!config) {
    try { config = sheetToObjects_(getSpreadsheet_(), 'Config'); } catch (e) { config = []; }
  }
  for (var i = 0; i < config.length; i++) {
    if (config[i].key === 'mapsApiKey' && config[i].value) return String(config[i].value);
  }
  return '';
}

/** Settings booleans only. Never values. */
function settingsStatus_() {
  var props = PropertiesService.getScriptProperties();
  var source = 'none';
  if (props.getProperty('mapsApiKey')) {
    source = 'scriptProperty';
  } else if (getMapsApiKey_()) {
    source = 'configSheet';
  }
  return {
    mapsApiKeyConfigured: source !== 'none',
    mapsApiKeySource: source,
    adminPinConfigured: !!props.getProperty('ADMIN_PIN')
  };
}

function getSpreadsheet_() {
  var sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!sheetId) {
    throw new Error('System not initialized. Call ?action=init first.');
  }
  return SpreadsheetApp.openById(sheetId);
}
