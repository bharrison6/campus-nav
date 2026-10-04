/**
 * AdminAPI.gs — Admin write operations (contract v2).
 *
 * Since v3 these run only in the local admin (tools/admin/server.mjs) on the operator's machine, in the Apps
 * Script stand-in; the server turns the resulting sheet into data/overrides/*.json after every write. The admin
 * is never served publicly, so there is no PIN; the site settings live in the build configuration (no map key).
 *
 * Rows are built from the tab's v2 headers (Init.gs getSheetDefinitions_), so a
 * record is passed as an object keyed by column name. Updates MERGE: a field
 * that is absent (undefined) keeps its stored value; null or '' clears it.
 *
 * Helpers end with an underscore so google.script.run cannot call them.
 */

// ============================================================================
// The admin-operation wrapper
// ============================================================================

/**
 * Takes the script lock, opens the spreadsheet, runs the callback, bumps
 * dataVersion, and returns the callback's result.
 */
function adminOp_(data, callback) {
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
// Generic header-driven row helpers
// ============================================================================

function tab_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Sheet tab missing: ' + name + '. Run initSystem().');
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
  validateRecord_(ss, tabName, obj, obj.id);
  appendRows_(t.sheet, t.def, [objectToRow_(t.def, obj, null)]);
  return { id: obj.id };
}

/** Merges data into the record with data.id; returns { updated: true }. */
function updateRecord_(ss, tabName, data, label) {
  validateRequired_(data, ['id']);
  var t = tab_(ss, tabName);
  var rowIndex = findRowById_(t.sheet, data.id);
  if (rowIndex === -1) throw new Error(label + ' not found: ' + data.id);
  validateRecord_(ss, tabName, data, data.id);
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
    validateRecord_(ss, tabName, obj, '[' + i + '] ' + obj.id);
    ids.push(String(obj.id));
    rows.push(objectToRow_(t.def, obj, null));
  }
  appendRows_(t.sheet, t.def, rows);
  return { count: ids.length, ids: ids };
}

// ============================================================================
// Record validation (Codex review v5, finding 5): every create, update and batch row, and every record of
// data/overrides when the local engine reads it (scripts/data/campus-engine.mjs), goes through recordProblem_.
// ============================================================================

var ACCESS_CLASSES_ = ['main', 'alt', 'emergency'];

/** Numeric columns per tab, with their range when they have one. */
var NUMBER_FIELDS_ = {
  Buildings: { lat: [-90, 90], lng: [-180, 180], levels: [0, 200], height: [0, 1000] },
  Floors: { level: null, widthPx: [0, Infinity], heightPx: [0, Infinity], metersPerPixel: [0, Infinity] },
  Rooms: { centerX: null, centerY: null },
  NavNodes: { x: null, y: null },
  NavEdges: { distance: [0, Infinity] },
  Photos: { x: null, y: null, lat: [-90, 90], lng: [-180, 180], heading: [-360, 360] }
};

/** Columns that name a record of another tab: tab -> {field: referenced tab}. */
var REFERENCE_FIELDS_ = {
  Floors: { buildingId: 'Buildings' },
  Rooms: { floorId: 'Floors' },
  NavNodes: { floorId: 'Floors', roomId: 'Rooms' },
  NavEdges: { fromNodeId: 'NavNodes', toNodeId: 'NavNodes' },
  Photos: { buildingId: 'Buildings', floorId: 'Floors' },
  QRLocations: { buildingId: 'Buildings', floorId: 'Floors', nodeId: 'NavNodes' }
};

function isBlank_(v) { return v === undefined || v === null || v === ''; }

/** A number or a numeric string (a sheet cell), else NaN. */
function numberOf_(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /\S/.test(v)) return Number(v);
  return NaN;
}

/** Why a room polygon is not a list of at least three [x, y] number pairs, or ''. */
function polygonProblem_(v) {
  var p = v;
  if (typeof v === 'string') {
    try { p = JSON.parse(v); } catch (e) { return 'polygon must be JSON: a list of [x, y] points'; }
  }
  if (Object.prototype.toString.call(p) !== '[object Array]' || p.length < 3) return 'polygon must be a list of at least three [x, y] points';
  for (var i = 0; i < p.length; i++) {
    var q = p[i];
    if (Object.prototype.toString.call(q) !== '[object Array]' || q.length < 2 || typeof q[0] !== 'number' || typeof q[1] !== 'number' ||
        !isFinite(q[0]) || !isFinite(q[1])) {
      return 'polygon point ' + (i + 1) + ' must be [x, y] numbers';
    }
  }
  return '';
}

/**
 * Why a record (the fields it sets) is not valid for a tab, or '' when it is. Only the fields present are checked, so
 * an update that sets one field is checked on that field.
 * @param {string} tabName
 * @param {Object} obj
 * @param {Function} [exists] (tabName, id) -> boolean: checks the ids the record names (omitted: not checked)
 */
function recordProblem_(tabName, obj, exists) {
  if (!obj || typeof obj !== 'object') return 'a record object is required';
  if ((tabName === 'Rooms' || tabName === 'NavNodes') && !isBlank_(obj.access) && ACCESS_CLASSES_.indexOf(obj.access) === -1) {
    return 'access must be main, alt or emergency (got ' + JSON.stringify(obj.access) + ')';
  }
  var nums = NUMBER_FIELDS_[tabName] || {};
  for (var f in nums) {
    if (!nums.hasOwnProperty(f) || isBlank_(obj[f])) continue;
    var n = numberOf_(obj[f]);
    if (!isFinite(n)) return f + ' must be a number (got ' + JSON.stringify(obj[f]) + ')';
    var r = nums[f];
    if (r && (n < r[0] || n > r[1])) return f + ' must be from ' + r[0] + ' to ' + r[1] + ' (got ' + n + ')';
  }
  if (tabName === 'Rooms' && !isBlank_(obj.polygon)) {
    var why = polygonProblem_(obj.polygon);
    if (why) return why;
  }
  if (tabName === 'NavEdges' && !isBlank_(obj.fromNodeId) && String(obj.fromNodeId) === String(obj.toNodeId)) {
    return 'an edge must join two different nodes';
  }
  if (exists) {
    var refs = REFERENCE_FIELDS_[tabName] || {};
    for (var k in refs) {
      if (!refs.hasOwnProperty(k) || isBlank_(obj[k])) continue;
      if (!exists(refs[k], String(obj[k]))) return k + ' names no ' + refs[k] + ' record: ' + obj[k];
    }
  }
  return '';
}

/** Throws a precise error when a record is not valid ("NavNodes ep-1-n0365: access must be ..."). */
function validateRecord_(ss, tabName, obj, where) {
  var why = recordProblem_(tabName, obj, function (t, id) { return findRowById_(tab_(ss, t).sheet, id) !== -1; });
  if (why) throw new Error(tabName + ' ' + (where || (obj && obj.id) || 'record') + ': ' + why);
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
 * @param {Object} data - buildingId, floorId, nodeId, description, permanent, expires.
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
// Rooms: id, floorId, number, label, type, polygon, centerX, centerY, searchable, access
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

/** @param {Object} data - floorId, rooms (array of room objects). */
function saveBatchRooms(data) {
  return adminOp_(data, function (ss) {
    validateRequired_(data, ['floorId', 'rooms']);
    requireNonEmptyArray_(data.rooms, 'rooms');
    return createBatch_(ss, 'Rooms', data.rooms, 'room-', { floorId: data.floorId });
  });
}

// ============================================================================
// NavNodes: id, floorId, x, y, type, roomId, linkId, access
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

/** @param {Object} data - floorId, nodes (array of node objects). */
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

/** @param {Object} data - edges (array of edge objects). */
function saveBatchNavEdges(data) {
  return adminOp_(data, function (ss) {
    validateRequired_(data, ['edges']);
    requireNonEmptyArray_(data.edges, 'edges');
    return createBatch_(ss, 'NavEdges', data.edges, 'edge-', null);
  });
}

// ============================================================================
// Buildings: id, name, code, number, lat, lng, entrances, photoUrl, hasIndoor, levels, height
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

/** @param {Object} data - id, entrances (array). */
function updateBuildingEntrances(data) {
  return adminOp_(data, function (ss) {
    validateRequired_(data, ['id', 'entrances']);
    return updateRecord_(ss, 'Buildings', { id: data.id, entrances: data.entrances }, 'Building');
  });
}
