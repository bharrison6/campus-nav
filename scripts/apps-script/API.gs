/**
 * API.gs — Data access layer.
 * All functions that read/write the Google Sheet.
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

function _getSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('SHEET_ID');
  if (!sheetId) {
    throw new Error('System not initialized. Call ?action=init first.');
  }
  return SpreadsheetApp.openById(sheetId);
}
