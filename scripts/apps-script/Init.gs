/**
 * Init.gs — Sheet creation, schema enforcement, and demo data seeding
 * for Murray State Campus Navigation.
 */

/**
 * Creates the backing Google Sheet (if it doesn't already exist),
 * ensures every tab has the right headers, seeds demo data on first run,
 * and returns the spreadsheet URL.
 *
 * Idempotent: safe to call multiple times.
 */
function initSystem() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('SHEET_ID');
  var ss = null;

  // Try to open existing sheet
  if (sheetId) {
    try {
      ss = SpreadsheetApp.openById(sheetId);
    } catch (e) {
      // Sheet was deleted or inaccessible — recreate
      ss = null;
      props.deleteProperty('SHEET_ID');
    }
  }

  // Create new sheet if needed
  if (!ss) {
    ss = SpreadsheetApp.create('Murray State Campus Nav - Data');
    props.setProperty('SHEET_ID', ss.getId());
    _ensureAllSheets(ss);
    _seedDemoData(ss);
  } else {
    // Ensure all tabs exist even on re-runs
    _ensureAllSheets(ss);
  }

  return {
    initialized: true,
    url: ss.getUrl()
  };
}

/**
 * Creates any missing sheets with their header rows.
 * Removes the default "Sheet1" if it exists and is empty.
 */
function _ensureAllSheets(ss) {
  var defs = _getSheetDefinitions();
  var existingSheets = ss.getSheets();
  var existingNames = {};
  for (var i = 0; i < existingSheets.length; i++) {
    existingNames[existingSheets[i].getName()] = true;
  }

  for (var d = 0; d < defs.length; d++) {
    var def = defs[d];
    if (!existingNames[def.name]) {
      var sheet = ss.insertSheet(def.name);
      sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
      sheet.setFrozenRows(1);
      // Bold the header row
      sheet.getRange(1, 1, 1, def.headers.length).setFontWeight('bold');
    }
  }

  // Remove default "Sheet1" if it exists and has no data beyond row 1
  try {
    var defaultSheet = ss.getSheetByName('Sheet1');
    if (defaultSheet && defaultSheet.getLastRow() <= 1 && defaultSheet.getLastColumn() <= 1) {
      // Only delete if we have other sheets (Sheets requires at least one)
      if (ss.getSheets().length > 1) {
        ss.deleteSheet(defaultSheet);
      }
    }
  } catch (e) {
    // Sheet1 doesn't exist — that's fine
  }
}

/**
 * Returns the schema definitions for all 8 data sheets.
 * Each entry: { name: string, headers: string[] }
 */
function _getSheetDefinitions() {
  return [
    {
      name: 'Config',
      headers: ['key', 'value']
    },
    {
      name: 'Buildings',
      headers: ['id', 'name', 'lat', 'lng', 'entrances', 'photoUrl']
    },
    {
      name: 'Floors',
      headers: ['id', 'buildingId', 'level', 'label', 'planImageUrl', 'widthPx', 'heightPx', 'metersPerPixel']
    },
    {
      name: 'Rooms',
      headers: ['id', 'floorId', 'number', 'label', 'polygon', 'centerX', 'centerY']
    },
    {
      name: 'NavNodes',
      headers: ['id', 'floorId', 'x', 'y', 'type', 'roomId']
    },
    {
      name: 'NavEdges',
      headers: ['id', 'fromNodeId', 'toNodeId', 'distance', 'floorChange']
    },
    {
      name: 'Photos',
      headers: ['id', 'type', 'buildingId', 'floorId', 'x', 'y', 'lat', 'lng', 'driveUrl', 'caption', 'heading']
    },
    {
      name: 'QRLocations',
      headers: ['id', 'buildingId', 'floorId', 'nodeId', 'description', 'permanent', 'expires', 'createdDate']
    }
  ];
}

/**
 * Seeds initial demo data into Config and Buildings sheets.
 * Only writes if the sheets are empty (header-only).
 */
function _seedDemoData(ss) {
  // Seed Config
  var configSheet = ss.getSheetByName('Config');
  if (configSheet && configSheet.getLastRow() <= 1) {
    configSheet.appendRow(['dataVersion', '1']);
    configSheet.appendRow(['mapsApiKey', '***REMOVED-GOOGLE-MAPS-API-KEY***']);
  }

  // Seed Buildings with one demo building
  var buildingsSheet = ss.getSheetByName('Buildings');
  if (buildingsSheet && buildingsSheet.getLastRow() <= 1) {
    buildingsSheet.appendRow([
      'bld-engphys',
      'Engineering & Physics Building',
      36.6622,
      -88.3253,
      '',   // entrances — to be filled later
      ''    // photoUrl — to be filled later
    ]);
  }
}
