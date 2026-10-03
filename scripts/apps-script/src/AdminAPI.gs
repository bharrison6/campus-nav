/**
 * AdminAPI.gs — Admin operations (contract v2). Every write requires the admin PIN.
 *
 * Rows are built from the tab's v2 headers (Init.gs getSheetDefinitions_), so a
 * record is passed as an object keyed by column name. Updates MERGE: a field
 * that is absent (undefined) keeps its stored value; null or '' clears it.
 *
 * Helpers end with an underscore so google.script.run cannot call them.
 */

// ============================================================================
// PIN, lockout, and the admin-operation wrapper
// ============================================================================

var PIN_FAILURE_LIMIT_ = 10;
var PIN_LOCKOUT_SECONDS_ = 600;

/**
 * Verifies the admin PIN against Script Property ADMIN_PIN.
 * After 10 failed attempts within 10 minutes all PIN checks are refused for
 * 10 minutes (the web app is anonymous, so the lockout is global).
 * @param {string} pin
 * @return {boolean} True if valid.
 */
function verifyAdminPin(pin) {
  var stored = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN');
  if (!stored) {
    throw new Error('Admin PIN not configured. Run ?action=init once; the generated PIN is then in the Apps Script editor under Project Settings > Script Properties (ADMIN_PIN).');
  }
  var cache = CacheService.getScriptCache();
  var failures = parseInt(cache.get('adminPinFailures') || '0', 10);
  if (failures >= PIN_FAILURE_LIMIT_) {
    throw new Error('Too many failed PIN attempts. Try again in 10 minutes.');
  }
  if (pin !== undefined && pin !== null && pin !== '' && String(pin) === String(stored)) {
    cache.remove('adminPinFailures');
    return true;
  }
  cache.put('adminPinFailures', String(failures + 1), PIN_LOCKOUT_SECONDS_);
  return false;
}

function requirePin_(pin) {
  if (!verifyAdminPin(pin)) {
    throw new Error('Invalid admin PIN');
  }
}

/**
 * Verifies data.pin, takes the script lock, opens the spreadsheet, runs the
 * callback, bumps dataVersion, and returns the callback's result.
 */
function adminOp_(data, callback) {
  requirePin_(data ? data.pin : '');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = getSpreadsheet_();
    var result = callback(ss);
    incrementDataVersion_(ss);
    return result;
  } finally {
    lock.releaseLock();
  }
}

/** Increments Config dataVersion so clients re-fetch; creates the row if missing. */
function incrementDataVersion_(ss) {
  var configSheet = ss.getSheetByName('Config');
  var data = configSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === 'dataVersion') {
      configSheet.getRange(i + 1, 2).setValue(String((parseInt(data[i][1], 10) || 0) + 1));
      return;
    }
  }
  configSheet.appendRow(['dataVersion', '1']);
}

// ============================================================================
// Settings (secrets live only in Script Properties; values never returned)
// ============================================================================

/**
 * Settings status for the admin Settings tab: booleans and the key's source,
 * never values. The admin page calls it after PIN login; a pin argument, when
 * passed, is verified.
 * @param {string=} pin
 * @return {Object} { mapsApiKeyConfigured, mapsApiKeySource, adminPinConfigured }
 */
function getSettingsStatus(pin) {
  if (pin !== undefined && pin !== null && pin !== '') requirePin_(pin);
  return settingsStatus_();
}

/**
 * Stores the Google Maps browser key in Script Property mapsApiKey.
 * An empty key removes the property (the Config sheet fallback then applies).
 * @param {string} pin
 * @param {string} key
 * @return {Object} settings status (booleans only)
 */
function setMapsApiKey(pin, key) {
  requirePin_(pin);
  var value = String(key === undefined || key === null ? '' : key).replace(/^\s+|\s+$/g, '');
  var props = PropertiesService.getScriptProperties();
  if (value === '') {
    props.deleteProperty('mapsApiKey');
  } else {
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(value)) {
      throw new Error('That does not look like a Google Maps API key (letters, digits, - and _, 20 to 128 characters).');
    }
    props.setProperty('mapsApiKey', value);
  }
  try { incrementDataVersion_(getSpreadsheet_()); } catch (e) { /* not initialized yet */ }
  return settingsStatus_();
}

/**
 * Changes ADMIN_PIN. The new PIN must be 6 to 20 characters with no spaces
 * (the admin page enforces the same rule; the generated first PIN is 6 digits).
 * @param {string} pin - Current PIN.
 * @param {string} newPin
 * @return {Object} { changed: true }
 */
function changeAdminPin(pin, newPin) {
  requirePin_(pin);
  var value = String(newPin === undefined || newPin === null ? '' : newPin).replace(/^\s+|\s+$/g, '');
  if (!/^\S{6,20}$/.test(value)) {
    throw new Error('The new PIN must be 6 to 20 characters with no spaces.');
  }
  PropertiesService.getScriptProperties().setProperty('ADMIN_PIN', value);
  CacheService.getScriptCache().remove('adminPinFailures');
  return { changed: true };
}

// ============================================================================
// Generic header-driven row helpers
// ============================================================================

function tab_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Sheet tab missing: ' + name + '. Run ?action=init.');
  return { sheet: sheet, def: getSheetDefinition_(name) };
}

/** Builds a stored row from an object; absent fields keep existingRow's values. */
function objectToRow_(def, obj, existingRow) {
  var row = [];
  for (var c = 0; c < def.headers.length; c++) {
    var h = def.headers[c];
    if (obj && obj.hasOwnProperty(h) && obj[h] !== undefined) {
      row.push(toCell_(def, h, obj[h]));
    } else {
      row.push(existingRow ? existingRow[c] : '');
    }
  }
  return row;
}

/** Accepts a row array (v2 header order) or an object keyed by header. */
function toRow_(def, item) {
  if (Object.prototype.toString.call(item) === '[object Array]') {
    if (item.length !== def.headers.length) {
      throw new Error(def.name + ' row has ' + item.length + ' columns; contract v2 expects ' + def.headers.length + '.');
    }
    return normalizeRow_(def, item);
  }
  return objectToRow_(def, item, null);
}

/** Scans column A for an id. @return {number} 1-based row index, or -1. */
function findRowById_(sheet, id) {
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

/** Appends stored rows below the last row, growing the sheet and text formats as needed. */
function appendRows_(sheet, def, rows) {
  if (!rows.length) return;
  var start = sheet.getLastRow() + 1;
  var needed = start + rows.length - 1;
  if (needed > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
  }
  formatTextRange_(sheet, def, start, rows.length);
  sheet.getRange(start, 1, rows.length, def.headers.length).setValues(rows);
}

/** Replaces all data rows of a tab with the given stored rows. */
function rewriteRows_(sheet, def, rows) {
  var last = sheet.getLastRow();
  if (last > 1) {
    sheet.getRange(2, 1, last - 1, Math.max(sheet.getLastColumn(), def.headers.length)).clearContent();
  }
  if (!rows.length) return;
  if (rows.length + 1 > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 1 - sheet.getMaxRows());
  }
  formatTextRange_(sheet, def, 2, rows.length);
  sheet.getRange(2, 1, rows.length, def.headers.length).setValues(rows);
}

function formatTextRange_(sheet, def, startRow, count) {
  if (!def.text) return;
  for (var i = 0; i < def.text.length; i++) {
    var col = def.headers.indexOf(def.text[i]);
    if (col !== -1) sheet.getRange(startRow, col + 1, count, 1).setNumberFormat('@');
  }
}

/** All stored data rows of a tab (header excluded). */
function dataRows_(sheet, def) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, def.headers.length).getValues();
}

function newId_(sheet, data, prefix) {
  if (data && data.id !== undefined && data.id !== null && data.id !== '') {
    var id = String(data.id);
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error('Invalid id: ' + id);
    if (findRowById_(sheet, id) !== -1) throw new Error('Id already exists: ' + id);
    return id;
  }
  return prefix + new Date().getTime();
}

/** Creates one record; returns { id }. */
function createRecord_(ss, tabName, data, prefix, required, forced) {
  validateRequired_(data, required);
  var t = tab_(ss, tabName);
  var obj = shallowCopy_(data);
  obj.id = newId_(t.sheet, data, prefix);
  if (forced) {
    for (var k in forced) if (forced.hasOwnProperty(k)) obj[k] = forced[k];
  }
  appendRows_(t.sheet, t.def, [objectToRow_(t.def, obj, null)]);
  return { id: obj.id };
}

/** Merges data into the record with data.id; returns { updated: true }. */
function updateRecord_(ss, tabName, data, label) {
  validateRequired_(data, ['id']);
  var t = tab_(ss, tabName);
  var rowIndex = findRowById_(t.sheet, data.id);
  if (rowIndex === -1) throw new Error(label + ' not found: ' + data.id);
  var existing = t.sheet.getRange(rowIndex, 1, 1, t.def.headers.length).getValues()[0];
  var row = objectToRow_(t.def, data, existing);
  row[0] = existing[0];
  formatTextRange_(t.sheet, t.def, rowIndex, 1);
  t.sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
  return { updated: true };
}

function deleteRecord_(ss, tabName, data, label) {
  validateRequired_(data, ['id']);
  var t = tab_(ss, tabName);
  var rowIndex = findRowById_(t.sheet, data.id);
  if (rowIndex === -1) throw new Error(label + ' not found: ' + data.id);
  t.sheet.deleteRow(rowIndex);
  return { deleted: true };
}

/** Creates many records in one write; returns { count, ids }. */
function createBatch_(ss, tabName, items, prefix, forced) {
  var t = tab_(ss, tabName);
  var base = new Date().getTime();
  var ids = [];
  var rows = [];
  for (var i = 0; i < items.length; i++) {
    var obj = shallowCopy_(items[i]);
    if (obj.id === undefined || obj.id === null || obj.id === '') obj.id = prefix + (base + i);
    if (forced) {
      for (var k in forced) if (forced.hasOwnProperty(k)) obj[k] = forced[k];
    }
    ids.push(String(obj.id));
    rows.push(objectToRow_(t.def, obj, null));
  }
  appendRows_(t.sheet, t.def, rows);
  return { count: ids.length, ids: ids };
}

function shallowCopy_(o) {
  var out = {};
  if (o) for (var k in o) if (o.hasOwnProperty(k)) out[k] = o[k];
  return out;
}

/** Throws when any listed field is missing (undefined, null, or ''). */
function validateRequired_(data, fields) {
  var missing = [];
  for (var i = 0; i < fields.length; i++) {
    if (!data || data[fields[i]] === undefined || data[fields[i]] === null || data[fields[i]] === '') {
      missing.push(fields[i]);
    }
  }
  if (missing.length > 0) {
    throw new Error('Missing required fields: ' + missing.join(', '));
  }
}

function requireNonEmptyArray_(value, name) {
  if (Object.prototype.toString.call(value) !== '[object Array]' || value.length === 0) {
    throw new Error(name + ' must be a non-empty array');
  }
}

// ============================================================================
// QR locations
// ============================================================================

/**
 * @param {Object} data - pin, buildingId, floorId, nodeId, description, permanent, expires.
 * @return {Object} { id }
 */
function saveQrLocation(data) {
  return adminOp_(data, function (ss) {
    validateRequired_(data, ['buildingId', 'nodeId', 'description']);
    if (typeof data.description !== 'string' || data.description.length > 500) {
      throw new Error('description must be a string of 500 characters or less');
    }
    if (data.expires && isNaN(Date.parse(data.expires))) {
      throw new Error('expires must be a valid date');
    }
    return createRecord_(ss, 'QRLocations', {
      buildingId: data.buildingId,
      floorId: data.floorId || '',
      nodeId: data.nodeId,
      description: data.description,
      permanent: !!data.permanent,
      expires: data.expires || '',
      createdDate: new Date().toISOString()
    }, 'qrloc-', []);
  });
}

// ============================================================================
// Floors: id, buildingId, level, label, planAsset, widthPx, heightPx, metersPerPixel, public
// ============================================================================

function saveFloor(data) {
  return adminOp_(data, function (ss) {
    return createRecord_(ss, 'Floors', data, 'floor-', ['buildingId', 'level', 'label']);
  });
}

function updateFloor(data) {
  return adminOp_(data, function (ss) { return updateRecord_(ss, 'Floors', data, 'Floor'); });
}

function deleteFloor(data) {
  return adminOp_(data, function (ss) { return deleteRecord_(ss, 'Floors', data, 'Floor'); });
}

// ============================================================================
// Rooms: id, floorId, number, label, type, polygon, centerX, centerY, searchable
// ============================================================================

function saveRoom(data) {
  return adminOp_(data, function (ss) {
    return createRecord_(ss, 'Rooms', data, 'room-', ['floorId', 'number']);
  });
}

function updateRoom(data) {
  return adminOp_(data, function (ss) { return updateRecord_(ss, 'Rooms', data, 'Room'); });
}

function deleteRoom(data) {
  return adminOp_(data, function (ss) { return deleteRecord_(ss, 'Rooms', data, 'Room'); });
}

/** @param {Object} data - pin, floorId, rooms (array of room objects). */
function saveBatchRooms(data) {
  return adminOp_(data, function (ss) {
    validateRequired_(data, ['floorId', 'rooms']);
    requireNonEmptyArray_(data.rooms, 'rooms');
    return createBatch_(ss, 'Rooms', data.rooms, 'room-', { floorId: data.floorId });
  });
}

// ============================================================================
// NavNodes: id, floorId, x, y, type, roomId, linkId
// NavEdges: id, fromNodeId, toNodeId, distance, floorChange, accessible
// ============================================================================

function saveNavNode(data) {
  return adminOp_(data, function (ss) {
    var d = shallowCopy_(data);
    if (!d.type) d.type = 'waypoint';
    return createRecord_(ss, 'NavNodes', d, 'nav-', ['floorId', 'x', 'y']);
  });
}

function updateNavNode(data) {
  return adminOp_(data, function (ss) { return updateRecord_(ss, 'NavNodes', data, 'NavNode'); });
}

/** Deletes a node and every edge touching it. @return {Object} { deleted, edgesRemoved } */
function deleteNavNode(data) {
  return adminOp_(data, function (ss) {
    validateRequired_(data, ['id']);
    var nodes = tab_(ss, 'NavNodes');
    var rowIndex = findRowById_(nodes.sheet, data.id);
    if (rowIndex === -1) throw new Error('NavNode not found: ' + data.id);

    var edges = tab_(ss, 'NavEdges');
    var rows = dataRows_(edges.sheet, edges.def);
    var kept = [];
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][1]) !== String(data.id) && String(rows[i][2]) !== String(data.id)) kept.push(rows[i]);
    }
    var edgesRemoved = rows.length - kept.length;
    if (edgesRemoved > 0) rewriteRows_(edges.sheet, edges.def, kept);

    nodes.sheet.deleteRow(rowIndex);
    return { deleted: true, edgesRemoved: edgesRemoved };
  });
}

/** @param {Object} data - pin, floorId, nodes (array of node objects). */
function saveBatchNavNodes(data) {
  return adminOp_(data, function (ss) {
    validateRequired_(data, ['floorId', 'nodes']);
    requireNonEmptyArray_(data.nodes, 'nodes');
    var items = [];
    for (var i = 0; i < data.nodes.length; i++) {
      var n = shallowCopy_(data.nodes[i]);
      if (!n.type) n.type = 'waypoint';
      items.push(n);
    }
    return createBatch_(ss, 'NavNodes', items, 'nav-', { floorId: data.floorId });
  });
}

function saveNavEdge(data) {
  return adminOp_(data, function (ss) {
    return createRecord_(ss, 'NavEdges', data, 'edge-', ['fromNodeId', 'toNodeId']);
  });
}

function updateNavEdge(data) {
  return adminOp_(data, function (ss) { return updateRecord_(ss, 'NavEdges', data, 'NavEdge'); });
}

function deleteNavEdge(data) {
  return adminOp_(data, function (ss) { return deleteRecord_(ss, 'NavEdges', data, 'NavEdge'); });
}

/** @param {Object} data - pin, edges (array of edge objects). */
function saveBatchNavEdges(data) {
  return adminOp_(data, function (ss) {
    validateRequired_(data, ['edges']);
    requireNonEmptyArray_(data.edges, 'edges');
    return createBatch_(ss, 'NavEdges', data.edges, 'edge-', null);
  });
}

// ============================================================================
// Floor import (pipeline JSON) and reseed
// ============================================================================

/**
 * Bulk-replaces one floor's rooms, nav nodes and nav edges from the floor
 * pipeline's JSON (data/floorplans/<floorId>.json).
 *
 * payload (object or JSON string):
 *   floorId            required (or floor.id)
 *   floor              optional Floors record to upsert (object keyed by header)
 *   rooms              array of room objects (or v2 row arrays)
 *   navNodes | nodes | nav.nodes   array of node objects (or v2 row arrays)
 *   navEdges | edges | nav.edges   array of edge objects (or v2 row arrays); may
 *                      include cross-floor edges to nodes on other floors
 * The pipeline's per-floor file is accepted as written: edges may use from/to
 * for fromNodeId/toNodeId, rooms may carry center: [x, y] for centerX/centerY.
 * Extra fields (area, doors, use text) are ignored.
 *
 * Replacement rule: every room and node on the floor is removed, then the
 * payload rows are written. An existing edge is removed when it shares an id
 * with an imported edge, when both its ends are on this floor (the payload's
 * edges replace them), or when either end no longer exists. Cross-floor edges
 * whose ends survive (node ids are stable across pipeline runs) are kept, so
 * re-importing one floor does not cut its stair and elevator links.
 *
 * @param {string} pin
 * @param {Object|string} payload
 * @return {Object} counts written and removed, danglingEdges, floorUpserted
 */
function importFloorData(pin, payload) {
  requirePin_(pin);
  var p = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (!p || typeof p !== 'object') throw new Error('importFloorData: payload must be an object or JSON string');
  var floorId = p.floorId || (p.floor && p.floor.id);
  if (typeof floorId !== 'string' || !/^[A-Za-z0-9-]+$/.test(floorId)) {
    throw new Error('importFloorData: floorId is required');
  }

  var roomDef = getSheetDefinition_('Rooms');
  var nodeDef = getSheetDefinition_('NavNodes');
  var edgeDef = getSheetDefinition_('NavEdges');
  var newRooms = importRows_(roomDef, p.rooms || [], floorId, 1);
  var nav = p.nav || {};
  var newNodes = importRows_(nodeDef, p.navNodes || p.nodes || nav.nodes || [], floorId, 1);
  var newEdges = importRows_(edgeDef, p.navEdges || p.edges || nav.edges || [], null, -1);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = getSpreadsheet_();
    var floorUpserted = false;
    if (p.floor) {
      var floorObj = shallowCopy_(p.floor);
      floorObj.id = floorId;
      var floors = tab_(ss, 'Floors');
      var fRow = findRowById_(floors.sheet, floorId);
      if (fRow === -1) {
        appendRows_(floors.sheet, floors.def, [objectToRow_(floors.def, floorObj, null)]);
      } else {
        var existing = floors.sheet.getRange(fRow, 1, 1, floors.def.headers.length).getValues()[0];
        formatTextRange_(floors.sheet, floors.def, fRow, 1);
        floors.sheet.getRange(fRow, 1, 1, floors.def.headers.length).setValues([objectToRow_(floors.def, floorObj, existing)]);
      }
      floorUpserted = true;
    }

    var rooms = tab_(ss, 'Rooms');
    var roomRows = dataRows_(rooms.sheet, rooms.def);
    var keptRooms = filterRows_(roomRows, function (r) { return String(r[1]) !== floorId; });
    rewriteRows_(rooms.sheet, rooms.def, keptRooms.concat(newRooms));

    var nodes = tab_(ss, 'NavNodes');
    var nodeRows = dataRows_(nodes.sheet, nodes.def);
    var touched = {};
    var keptNodes = filterRows_(nodeRows, function (r) {
      if (String(r[1]) === floorId) { touched[String(r[0])] = true; return false; }
      return true;
    });
    for (var n = 0; n < newNodes.length; n++) touched[String(newNodes[n][0])] = true;
    rewriteRows_(nodes.sheet, nodes.def, keptNodes.concat(newNodes));

    var allNodes = {};
    for (var k = 0; k < keptNodes.length; k++) allNodes[String(keptNodes[k][0])] = true;
    for (var m = 0; m < newNodes.length; m++) allNodes[String(newNodes[m][0])] = true;

    var newEdgeIds = {};
    for (var e = 0; e < newEdges.length; e++) newEdgeIds[String(newEdges[e][0])] = true;
    var edges = tab_(ss, 'NavEdges');
    var edgeRows = dataRows_(edges.sheet, edges.def);
    var crossFloorKept = 0;
    var keptEdges = filterRows_(edgeRows, function (r) {
      var from = String(r[1]);
      var to = String(r[2]);
      if (newEdgeIds[String(r[0])]) return false;
      if (touched[from] && touched[to]) return false;
      if (!allNodes[from] || !allNodes[to]) return false;
      if (touched[from] || touched[to]) crossFloorKept++;
      return true;
    });
    rewriteRows_(edges.sheet, edges.def, keptEdges.concat(newEdges));

    var dangling = 0;
    for (var d = 0; d < newEdges.length; d++) {
      if (!allNodes[String(newEdges[d][1])] || !allNodes[String(newEdges[d][2])]) dangling++;
    }

    incrementDataVersion_(ss);
    return {
      floorId: floorId,
      floorUpserted: floorUpserted,
      written: { rooms: newRooms.length, navNodes: newNodes.length, navEdges: newEdges.length },
      removed: {
        rooms: roomRows.length - keptRooms.length,
        navNodes: nodeRows.length - keptNodes.length,
        navEdges: edgeRows.length - keptEdges.length
      },
      crossFloorEdgesKept: crossFloorKept,
      danglingEdges: dangling
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Converts import items to stored rows; enforces ids, uniqueness, and (when
 * floorCol >= 0) that every row belongs to floorId (filled in when blank).
 */
function importRows_(def, items, floorId, floorCol) {
  if (Object.prototype.toString.call(items) !== '[object Array]') {
    throw new Error('importFloorData: ' + def.name + ' must be an array');
  }
  var rows = [];
  var seen = {};
  for (var i = 0; i < items.length; i++) {
    var row = toRow_(def, importAliases_(def.name, items[i]));
    if (floorCol >= 0) {
      if (row[floorCol] === '' || row[floorCol] === null) row[floorCol] = floorId;
      if (String(row[floorCol]) !== floorId) {
        throw new Error('importFloorData: ' + def.name + ' ' + row[0] + ' belongs to ' + row[floorCol] + ', not ' + floorId);
      }
    }
    if (!row[0]) throw new Error('importFloorData: ' + def.name + ' item ' + (i + 1) + ' has no id');
    if (seen[row[0]]) throw new Error('importFloorData: duplicate ' + def.name + ' id ' + row[0]);
    seen[row[0]] = true;
    rows.push(row);
  }
  return rows;
}

/**
 * Maps the pipeline's per-floor JSON field names onto contract headers:
 * edges from/to -> fromNodeId/toNodeId, rooms center [x, y] -> centerX/centerY.
 * Row arrays and objects that already use the contract names pass through.
 */
function importAliases_(tabName, item) {
  if (!item || typeof item !== 'object' || Object.prototype.toString.call(item) === '[object Array]') return item;
  var o = shallowCopy_(item);
  if (tabName === 'NavEdges') {
    if (o.fromNodeId === undefined && o.from !== undefined) o.fromNodeId = o.from;
    if (o.toNodeId === undefined && o.to !== undefined) o.toNodeId = o.to;
  } else if (tabName === 'Rooms') {
    if (o.centerX === undefined && Object.prototype.toString.call(o.center) === '[object Array]') {
      o.centerX = o.center[0];
      o.centerY = o.center[1];
    }
  }
  return o;
}

function filterRows_(rows, keep) {
  var out = [];
  for (var i = 0; i < rows.length; i++) if (keep(rows[i])) out.push(rows[i]);
  return out;
}

/**
 * Clears and re-seeds Buildings, Floors, Rooms, NavNodes and NavEdges from
 * SeedData.gs / SeedFloorData.gs. Seeds are validated before anything is cleared.
 * @param {Object} data - pin.
 * @return {Object} { reseeded: true, seeded }
 */
function reseedCampusData(data) {
  return adminOp_(data, function (ss) {
    var datasets = getSeedDatasets_();
    for (var v = 0; v < datasets.length; v++) validateSeedRows_(datasets[v].name, datasets[v].rows);
    for (var i = 0; i < datasets.length; i++) {
      var sheet = ss.getSheetByName(datasets[i].name);
      if (sheet && sheet.getLastRow() > 1) {
        sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.max(sheet.getLastColumn(), 1)).clearContent();
      }
    }
    return { reseeded: true, seeded: seedAllCampusData(ss) };
  });
}

// ============================================================================
// Buildings: id, name, code, number, lat, lng, entrances, photoUrl, hasIndoor
// ============================================================================

function saveBuilding(data) {
  return adminOp_(data, function (ss) {
    return createRecord_(ss, 'Buildings', data, 'bld-', ['name']);
  });
}

function deleteBuilding(data) {
  return adminOp_(data, function (ss) { return deleteRecord_(ss, 'Buildings', data, 'Building'); });
}

function updateBuilding(data) {
  return adminOp_(data, function (ss) { return updateRecord_(ss, 'Buildings', data, 'Building'); });
}

/** @param {Object} data - pin, id, entrances (array). */
function updateBuildingEntrances(data) {
  return adminOp_(data, function (ss) {
    validateRequired_(data, ['id', 'entrances']);
    return updateRecord_(ss, 'Buildings', { id: data.id, entrances: data.entrances }, 'Building');
  });
}
