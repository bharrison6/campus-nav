/**
 * AdminAPI.gs — Admin operations for managing campus data.
 * All write operations require admin PIN authentication.
 */

/**
 * Verifies the admin PIN against the value stored in Script Properties.
 * Set the PIN via: Script Editor → Project Settings → Script Properties → Add "ADMIN_PIN".
 * @param {string} pin - The PIN to verify.
 * @return {boolean} True if valid.
 */
function verifyAdminPin(pin) {
  var stored = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN');
  if (!stored) {
    throw new Error('Admin PIN not configured. Set ADMIN_PIN in Script Properties.');
  }
  return pin === stored;
}

/**
 * Saves a new QR location to the QRLocations sheet.
 * Requires admin PIN for authorization.
 * @param {Object} data - QR location data with pin, buildingId, floorId, nodeId, description, permanent, expires.
 * @return {Object} The created QR location id.
 */
function saveQrLocation(data) {
  // Authenticate
  if (!data || !verifyAdminPin(data.pin)) {
    throw new Error('Invalid admin PIN');
  }

  // Validate required fields
  if (!data.buildingId || typeof data.buildingId !== 'string') {
    throw new Error('buildingId is required');
  }
  if (!data.nodeId || typeof data.nodeId !== 'string') {
    throw new Error('nodeId is required');
  }
  if (!data.description || typeof data.description !== 'string') {
    throw new Error('description is required');
  }
  if (data.description.length > 500) {
    throw new Error('description must be 500 characters or less');
  }
  if (data.expires && isNaN(Date.parse(data.expires))) {
    throw new Error('expires must be a valid date');
  }

  var ss = _getSpreadsheet();
  var sheet = ss.getSheetByName('QRLocations');
  var id = 'qrloc-' + Date.now();
  sheet.appendRow([
    id,
    data.buildingId,
    data.floorId || '',
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
 * Increments the dataVersion in Config sheet so clients know to re-fetch.
 * Creates the dataVersion row if it does not exist.
 * @param {Spreadsheet} ss - The backing spreadsheet.
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
  // dataVersion row not found — create it
  configSheet.appendRow(['dataVersion', '1']);
}

// ============================================================================
// Floor plan file operations (Drive access)
// ============================================================================

/**
 * Fetches a file from Google Drive and returns it as base64 string.
 * Used to bypass CORS when loading floor plan images from Drive.
 * No PIN required — read-only operation on files already shared.
 * @param {string} fileId - Google Drive file ID.
 * @return {Object} Base64 content and MIME type.
 */
function getFloorPlanFile(fileId) {
  if (!fileId || typeof fileId !== 'string') {
    throw new Error('fileId is required');
  }
  // Validate that this file ID is referenced in Floors sheet planImageUrl
  var ss = _getSpreadsheet();
  var floorsSheet = ss.getSheetByName('Floors');
  var data = floorsSheet.getDataRange().getValues();
  var allowed = false;
  for (var i = 1; i < data.length; i++) {
    var url = String(data[i][4]); // planImageUrl column
    if (url.indexOf(fileId) !== -1) { allowed = true; break; }
  }
  if (!allowed) {
    throw new Error('File not found in floor plan data');
  }
  var file = DriveApp.getFileById(fileId);
  // Guard against oversized files (base64 + google.script.run ~6.75MB limit)
  if (file.getSize() > 5 * 1024 * 1024) {
    throw new Error('File too large for server-side fetch');
  }
  var blob = file.getBlob();
  return {
    base64: Utilities.base64Encode(blob.getBytes()),
    mimeType: blob.getContentType(),
    name: file.getName()
  };
}

/**
 * Uploads a file to Google Drive from base64 content.
 * Sets sharing to anyone with link can view.
 * Requires admin PIN.
 * @param {Object} data - Must contain pin, content (base64), mimeType, filename.
 * @return {Object} File ID and Drive URL.
 */
function uploadFloorPlanFile(data) {
  return _adminOp(data, function(ss) {
    _validateRequired(data, ['content', 'mimeType', 'filename']);
    var bytes = Utilities.base64Decode(data.content);
    var blob = Utilities.newBlob(bytes, data.mimeType, data.filename);
    var file = DriveApp.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return {
      fileId: file.getId(),
      url: 'https://drive.google.com/file/d/' + file.getId() + '/view'
    };
  });
}

// ============================================================================
// Task 0A: Generic CRUD helpers
// ============================================================================

/**
 * Admin operation wrapper. Verifies PIN, opens spreadsheet, runs callback,
 * increments data version, and returns the callback's result.
 * @param {Object} data - Must contain data.pin for authentication.
 * @param {Function} callback - Receives the spreadsheet; return value is passed through.
 * @return {*} The callback's return value.
 */
function _adminOp(data, callback) {
  if (!data || !verifyAdminPin(data.pin)) {
    throw new Error('Invalid admin PIN');
  }
  var ss = _getSpreadsheet();
  var result = callback(ss);
  _incrementDataVersion(ss);
  return result;
}

/**
 * Scans column A of a sheet for a matching ID (skips header row).
 * @param {Sheet} sheet - The sheet to search.
 * @param {string} id - The ID value to find.
 * @return {number} 1-based row index, or -1 if not found.
 */
function _findRowById(sheet, id) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      return i + 1; // 1-based row index
    }
  }
  return -1;
}

/**
 * Updates a specific row with the given values array.
 * @param {Sheet} sheet - The sheet to update.
 * @param {number} rowIndex - 1-based row index.
 * @param {Array} values - Array of values matching the row's columns.
 */
function _updateRow(sheet, rowIndex, values) {
  sheet.getRange(rowIndex, 1, 1, values.length).setValues([values]);
}

/**
 * Deletes a row at the given 1-based index.
 * @param {Sheet} sheet - The sheet to modify.
 * @param {number} rowIndex - 1-based row index.
 */
function _deleteRow(sheet, rowIndex) {
  sheet.deleteRow(rowIndex);
}

/**
 * Validates that all required fields are present in data.
 * @param {Object} data - The data object to validate.
 * @param {Array} fields - Array of required field name strings.
 * @throws {Error} If any fields are missing.
 */
function _validateRequired(data, fields) {
  var missing = [];
  for (var i = 0; i < fields.length; i++) {
    if (data[fields[i]] === undefined || data[fields[i]] === null || data[fields[i]] === '') {
      missing.push(fields[i]);
    }
  }
  if (missing.length > 0) {
    throw new Error('Missing required fields: ' + missing.join(', '));
  }
}

// ============================================================================
// Task 0B: Floor CRUD
// Columns: id, buildingId, level, label, planImageUrl, widthPx, heightPx, metersPerPixel
// ============================================================================

/**
 * Creates a new floor record.
 * @param {Object} data - Floor data with pin, buildingId, level, label, and optional fields.
 * @return {Object} The created floor id.
 */
function saveFloor(data) {
  return _adminOp(data, function(ss) {
    _validateRequired(data, ['buildingId', 'level', 'label']);
    var sheet = ss.getSheetByName('Floors');
    var id = 'floor-' + Date.now();
    sheet.appendRow([
      id,
      data.buildingId,
      data.level,
      data.label,
      data.planImageUrl || '',
      data.widthPx || '',
      data.heightPx || '',
      data.metersPerPixel || ''
    ]);
    return { id: id };
  });
}

/**
 * Updates an existing floor record.
 * @param {Object} data - Floor data with pin, id, and fields to update.
 * @return {Object} Confirmation.
 */
function updateFloor(data) {
  return _adminOp(data, function(ss) {
    _validateRequired(data, ['id']);
    var sheet = ss.getSheetByName('Floors');
    var rowIndex = _findRowById(sheet, data.id);
    if (rowIndex === -1) {
      throw new Error('Floor not found: ' + data.id);
    }
    _updateRow(sheet, rowIndex, [
      data.id,
      data.buildingId || '',
      data.level || '',
      data.label || '',
      data.planImageUrl || '',
      data.widthPx || '',
      data.heightPx || '',
      data.metersPerPixel || ''
    ]);
    return { updated: true };
  });
}

/**
 * Deletes a floor record.
 * @param {Object} data - Must contain pin and id.
 * @return {Object} Confirmation.
 */
function deleteFloor(data) {
  return _adminOp(data, function(ss) {
    _validateRequired(data, ['id']);
    var sheet = ss.getSheetByName('Floors');
    var rowIndex = _findRowById(sheet, data.id);
    if (rowIndex === -1) {
      throw new Error('Floor not found: ' + data.id);
    }
    _deleteRow(sheet, rowIndex);
    return { deleted: true };
  });
}

// ============================================================================
// Task 0C: Room CRUD + batch
// Columns: id, floorId, number, label, polygon, centerX, centerY
// ============================================================================

/**
 * Creates a new room record.
 * @param {Object} data - Room data with pin, floorId, number, and optional fields.
 * @return {Object} The created room id.
 */
function saveRoom(data) {
  return _adminOp(data, function(ss) {
    _validateRequired(data, ['floorId', 'number']);
    var sheet = ss.getSheetByName('Rooms');
    var id = 'room-' + Date.now();
    var polygon = data.polygon ? JSON.stringify(data.polygon) : '';
    sheet.appendRow([
      id,
      data.floorId,
      data.number,
      data.label || '',
      polygon,
      data.centerX || '',
      data.centerY || ''
    ]);
    return { id: id };
  });
}

/**
 * Updates an existing room record.
 * @param {Object} data - Room data with pin, id, and fields to update.
 * @return {Object} Confirmation.
 */
function updateRoom(data) {
  return _adminOp(data, function(ss) {
    _validateRequired(data, ['id']);
    var sheet = ss.getSheetByName('Rooms');
    var rowIndex = _findRowById(sheet, data.id);
    if (rowIndex === -1) {
      throw new Error('Room not found: ' + data.id);
    }
    var polygon = data.polygon ? JSON.stringify(data.polygon) : '';
    _updateRow(sheet, rowIndex, [
      data.id,
      data.floorId || '',
      data.number || '',
      data.label || '',
      polygon,
      data.centerX || '',
      data.centerY || ''
    ]);
    return { updated: true };
  });
}

/**
 * Deletes a room record.
 * @param {Object} data - Must contain pin and id.
 * @return {Object} Confirmation.
 */
function deleteRoom(data) {
  return _adminOp(data, function(ss) {
    _validateRequired(data, ['id']);
    var sheet = ss.getSheetByName('Rooms');
    var rowIndex = _findRowById(sheet, data.id);
    if (rowIndex === -1) {
      throw new Error('Room not found: ' + data.id);
    }
    _deleteRow(sheet, rowIndex);
    return { deleted: true };
  });
}

/**
 * Batch-creates multiple room records in a single API call.
 * @param {Object} data - Must contain pin, floorId, and rooms (array of room objects).
 * @return {Object} Count and array of created IDs.
 */
function saveBatchRooms(data) {
  return _adminOp(data, function(ss) {
    _validateRequired(data, ['floorId', 'rooms']);
    if (!Array.isArray(data.rooms) || data.rooms.length === 0) {
      throw new Error('rooms must be a non-empty array');
    }
    var sheet = ss.getSheetByName('Rooms');
    var ids = [];
    var rows = [];
    for (var i = 0; i < data.rooms.length; i++) {
      var room = data.rooms[i];
      var id = 'room-' + (Date.now() + i);
      ids.push(id);
      var polygon = room.polygon ? JSON.stringify(room.polygon) : '';
      rows.push([
        id,
        data.floorId,
        room.number || '',
        room.label || '',
        polygon,
        room.centerX || '',
        room.centerY || ''
      ]);
    }
    var startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rows.length, 7).setValues(rows);
    return { count: ids.length, ids: ids };
  });
}

// ============================================================================
// Task 0D: NavNode/Edge CRUD + batch
// NavNodes columns: id, floorId, x, y, type, roomId
// NavEdges columns: id, fromNodeId, toNodeId, distance, floorChange
// ============================================================================

/**
 * Creates a new navigation node.
 * @param {Object} data - Node data with pin, floorId, x, y, and optional type/roomId.
 * @return {Object} The created node id.
 */
function saveNavNode(data) {
  return _adminOp(data, function(ss) {
    _validateRequired(data, ['floorId', 'x', 'y']);
    var sheet = ss.getSheetByName('NavNodes');
    var id = 'nav-' + Date.now();
    sheet.appendRow([
      id,
      data.floorId,
      data.x,
      data.y,
      data.type || 'waypoint',
      data.roomId || ''
    ]);
    return { id: id };
  });
}

/**
 * Updates an existing navigation node.
 * @param {Object} data - Node data with pin, id, and fields to update.
 * @return {Object} Confirmation.
 */
function updateNavNode(data) {
  return _adminOp(data, function(ss) {
    _validateRequired(data, ['id']);
    var sheet = ss.getSheetByName('NavNodes');
    var rowIndex = _findRowById(sheet, data.id);
    if (rowIndex === -1) {
      throw new Error('NavNode not found: ' + data.id);
    }
    _updateRow(sheet, rowIndex, [
      data.id,
      data.floorId || '',
      data.x || '',
      data.y || '',
      data.type || 'waypoint',
      data.roomId || ''
    ]);
    return { updated: true };
  });
}

/**
 * Deletes a navigation node and cascades to remove connected edges.
 * @param {Object} data - Must contain pin and id.
 * @return {Object} Confirmation with count of edges removed.
 */
function deleteNavNode(data) {
  return _adminOp(data, function(ss) {
    _validateRequired(data, ['id']);
    var nodeSheet = ss.getSheetByName('NavNodes');
    var rowIndex = _findRowById(nodeSheet, data.id);
    if (rowIndex === -1) {
      throw new Error('NavNode not found: ' + data.id);
    }

    // CASCADE: Delete connected edges
    var edgeSheet = ss.getSheetByName('NavEdges');
    var edgeData = edgeSheet.getDataRange().getValues();
    var edgesRemoved = 0;
    // Delete from bottom to top to preserve row indices
    for (var i = edgeData.length - 1; i >= 1; i--) {
      if (String(edgeData[i][1]) === String(data.id) || String(edgeData[i][2]) === String(data.id)) {
        edgeSheet.deleteRow(i + 1); // 1-based row index
        edgesRemoved++;
      }
    }

    // Delete the node itself
    // Re-find in case row indices shifted (they shouldn't since it's a different sheet)
    _deleteRow(nodeSheet, rowIndex);
    return { deleted: true, edgesRemoved: edgesRemoved };
  });
}

/**
 * Batch-creates multiple navigation nodes in a single API call.
 * @param {Object} data - Must contain pin, floorId, and nodes (array of node objects).
 * @return {Object} Count and array of created IDs.
 */
function saveBatchNavNodes(data) {
  return _adminOp(data, function(ss) {
    _validateRequired(data, ['floorId', 'nodes']);
    if (!Array.isArray(data.nodes) || data.nodes.length === 0) {
      throw new Error('nodes must be a non-empty array');
    }
    var sheet = ss.getSheetByName('NavNodes');
    var ids = [];
    var rows = [];
    for (var i = 0; i < data.nodes.length; i++) {
      var node = data.nodes[i];
      var id = 'nav-' + (Date.now() + i);
      ids.push(id);
      rows.push([
        id,
        data.floorId,
        node.x || '',
        node.y || '',
        node.type || 'waypoint',
        node.roomId || ''
      ]);
    }
    var startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rows.length, 6).setValues(rows);
    return { count: ids.length, ids: ids };
  });
}

/**
 * Creates a new navigation edge.
 * @param {Object} data - Edge data with pin, fromNodeId, toNodeId, and optional distance/floorChange.
 * @return {Object} The created edge id.
 */
function saveNavEdge(data) {
  return _adminOp(data, function(ss) {
    _validateRequired(data, ['fromNodeId', 'toNodeId']);
    var sheet = ss.getSheetByName('NavEdges');
    var id = 'edge-' + Date.now();
    sheet.appendRow([
      id,
      data.fromNodeId,
      data.toNodeId,
      data.distance || '',
      data.floorChange || ''
    ]);
    return { id: id };
  });
}

/**
 * Deletes a navigation edge.
 * @param {Object} data - Must contain pin and id.
 * @return {Object} Confirmation.
 */
function deleteNavEdge(data) {
  return _adminOp(data, function(ss) {
    _validateRequired(data, ['id']);
    var sheet = ss.getSheetByName('NavEdges');
    var rowIndex = _findRowById(sheet, data.id);
    if (rowIndex === -1) {
      throw new Error('NavEdge not found: ' + data.id);
    }
    _deleteRow(sheet, rowIndex);
    return { deleted: true };
  });
}

/**
 * Batch-creates multiple navigation edges in a single API call.
 * @param {Object} data - Must contain pin and edges (array of edge objects).
 * @return {Object} Count and array of created IDs.
 */
function saveBatchNavEdges(data) {
  return _adminOp(data, function(ss) {
    _validateRequired(data, ['edges']);
    if (!Array.isArray(data.edges) || data.edges.length === 0) {
      throw new Error('edges must be a non-empty array');
    }
    var sheet = ss.getSheetByName('NavEdges');
    var ids = [];
    var rows = [];
    for (var i = 0; i < data.edges.length; i++) {
      var edge = data.edges[i];
      var id = 'edge-' + (Date.now() + i);
      ids.push(id);
      rows.push([
        id,
        edge.fromNodeId || '',
        edge.toNodeId || '',
        edge.distance || '',
        edge.floorChange || ''
      ]);
    }
    var startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rows.length, 5).setValues(rows);
    return { count: ids.length, ids: ids };
  });
}

// ============================================================================
// Reseed: Clear and repopulate campus data
// ============================================================================

/**
 * Clears and re-seeds Buildings, Floors, and Rooms sheets.
 * Preserves headers. Requires admin PIN.
 * @param {Object} data - Must contain pin.
 * @return {Object} Confirmation.
 */
function reseedCampusData(data) {
  return _adminOp(data, function(ss) {
    var sheetNames = ['Buildings', 'Floors', 'Rooms'];
    for (var i = 0; i < sheetNames.length; i++) {
      var sheet = ss.getSheetByName(sheetNames[i]);
      if (sheet && sheet.getLastRow() > 1) {
        sheet.deleteRows(2, sheet.getLastRow() - 1);
      }
    }
    seedAllCampusData(ss);
    return { reseeded: true };
  });
}

// ============================================================================
// Task 0E: Building CRUD
// Columns: id, name, lat, lng, entrances, photoUrl
// ============================================================================

/**
 * Creates a new building record.
 * @param {Object} data - Building data with pin, name. Optional: lat, lng, photoUrl.
 * @return {Object} The created building id.
 */
function saveBuilding(data) {
  return _adminOp(data, function(ss) {
    _validateRequired(data, ['name']);
    var sheet = ss.getSheetByName('Buildings');
    var id = 'bld-' + Date.now();
    sheet.appendRow([
      id,
      data.name,
      data.lat || '',
      data.lng || '',
      '',
      data.photoUrl || ''
    ]);
    return { id: id };
  });
}

/**
 * Deletes a building record.
 * @param {Object} data - Must contain pin and id.
 * @return {Object} Confirmation.
 */
function deleteBuilding(data) {
  return _adminOp(data, function(ss) {
    _validateRequired(data, ['id']);
    var sheet = ss.getSheetByName('Buildings');
    var rowIndex = _findRowById(sheet, data.id);
    if (rowIndex === -1) {
      throw new Error('Building not found: ' + data.id);
    }
    _deleteRow(sheet, rowIndex);
    return { deleted: true };
  });
}

/**
 * Updates an existing building record.
 * @param {Object} data - Building data with pin, id, and fields to update.
 * @return {Object} Confirmation.
 */
function updateBuilding(data) {
  return _adminOp(data, function(ss) {
    _validateRequired(data, ['id']);
    var sheet = ss.getSheetByName('Buildings');
    var rowIndex = _findRowById(sheet, data.id);
    if (rowIndex === -1) {
      throw new Error('Building not found: ' + data.id);
    }
    var entrances = data.entrances ? JSON.stringify(data.entrances) : '';
    _updateRow(sheet, rowIndex, [
      data.id,
      data.name || '',
      data.lat || '',
      data.lng || '',
      entrances,
      data.photoUrl || ''
    ]);
    return { updated: true };
  });
}

/**
 * Updates only the entrances field for a building.
 * Does NOT use _adminOp — handles PIN check and version increment directly.
 * @param {Object} data - Must contain pin, id, and entrances (array).
 * @return {Object} Confirmation.
 */
function updateBuildingEntrances(data) {
  if (!data || !verifyAdminPin(data.pin)) {
    throw new Error('Invalid admin PIN');
  }
  _validateRequired(data, ['id', 'entrances']);
  var ss = _getSpreadsheet();
  var sheet = ss.getSheetByName('Buildings');
  var rowIndex = _findRowById(sheet, data.id);
  if (rowIndex === -1) {
    throw new Error('Building not found: ' + data.id);
  }
  sheet.getRange(rowIndex, 5).setValue(JSON.stringify(data.entrances));
  _incrementDataVersion(ss);
  return { updated: true };
}
