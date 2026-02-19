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
