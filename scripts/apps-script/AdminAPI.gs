/**
 * AdminAPI.gs — Admin operations for managing campus data.
 */

/**
 * Saves a new QR location to the QRLocations sheet.
 * @param {Object} data - QR location data with buildingId, floorId, nodeId, description, permanent, expires.
 * @return {Object} The created QR location id.
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
 * Increments the dataVersion in Config sheet so clients know to re-fetch.
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
}
