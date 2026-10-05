/**
 * SeedData.gs — Campus seed data for Murray State Campus Navigation (contract v2).
 *
 * Buildings: 89 building coordinates sourced from the campus-maps.com
 * interactive map, kept here by hand.
 * Floors, Rooms, NavNodes, NavEdges: generated from the CAD floor plans by
 * scripts/floorplan-pipeline into SeedFloorData.gs (getGenerated*Seed()).
 * The old PDF-derived floor and room rows were removed in v2.
 */

/**
 * Hand-maintained building base rows: [id, name, lat, lng, entrances, photoUrl].
 * getBuildingsSeedRows_() expands them to the v2 Buildings header order.
 */
function getBuildingsBaseRows_() {
  return [
    ['bld-ac',              'Sid Easley Alumni Center',                                      36.619429, -88.315557, '', ''],
    ['bld-al',              'Alexander Hall',                                                36.614003, -88.324877, '', ''],
    ['bld-as',              'Oakley Applied Science Building',                               36.614082, -88.322444, '', ''],
    ['bld-as-north',        'Oakley Applied Science Building North',                         36.614400, -88.322360, '', ''],
    ['bld-as-south',        'Oakley Applied Science Building South',                         36.613799, -88.322364, '', ''],
    ['bld-basketball-cts',  'Basketball Courts',                                             36.619656, -88.319382, '', ''],
    ['bld-bauernfeind',     'Arthur J. Bauernfeind College of Business',                     36.611723, -88.323687, '', ''],
    ['bld-bb',              'Business Building',                                             36.611586, -88.323397, '', ''],
    ['bld-bg',              'Biology Building',                                              36.613505, -88.325806, '', ''],
    ['bld-bl',              'Blackburn Science Building',                                    36.614806, -88.322556, '', ''],
    ['bld-burton-hoc',      'Burton Family Hall of Champions',                               36.623162, -88.319642, '', ''],
    ['bld-cb',              'Jesse D. Jones Hall (Chemistry Building)',                       36.612529, -88.325798, '', ''],
    ['bld-cc',              'Curris Center',                                                 36.615516, -88.321300, '', ''],
    ['bld-cc100',           'College Courts 100',                                            36.622411, -88.321825, '', ''],
    ['bld-cc1000',          'College Courts 1000',                                           36.621565, -88.321226, '', ''],
    ['bld-cc1100',          'College Courts 1100',                                           36.620947, -88.321224, '', ''],
    ['bld-cc1200',          'College Courts 1200',                                           36.620517, -88.321232, '', ''],
    ['bld-cc200',           'College Courts 200',                                            36.622011, -88.322050, '', ''],
    ['bld-cc300',           'College Courts 300',                                            36.621556, -88.321621, '', ''],
    ['bld-cc400',           'College Courts 400',                                            36.621563, -88.322045, '', ''],
    ['bld-cc500',           'College Courts 500',                                            36.621104, -88.321835, '', ''],
    ['bld-cc600',           'College Courts 600',                                            36.620809, -88.321688, '', ''],
    ['bld-cc700',           'College Courts 700',                                            36.620159, -88.321838, '', ''],
    ['bld-cc800',           'College Courts 800',                                            36.620517, -88.322028, '', ''],
    ['bld-central-plant',   'Central Heating and Cooling Plant',                             36.615038, -88.323440, '', ''],
    ['bld-cf',              'Cutchin Field',                                                 36.615692, -88.320268, '', ''],
    ['bld-cfsb',            'CFSB Center',                                                   36.622666, -88.319995, '', ''],
    ['bld-ch',              'John W. Carr Hall',                                             36.614449, -88.321228, '', ''],
    ['bld-cherry-expo',     'Cherry Exposition Center',                                      36.616685, -88.338938, '', ''],
    ['bld-chickfila',       'Chick-fil-A',                                                   36.615636, -88.321603, '', ''],
    ['bld-ck',              'Lee Clark College',                                             36.618350, -88.322445, '', ''],
    ['bld-cp',              'Carman Pavilion',                                               36.616864, -88.340319, '', ''],
    ['bld-ct',              'College Courts Apartments',                                     36.620899, -88.322020, '', ''],
    ['bld-diamond-sports',  'Diamond Sports Indoor Facility',                                36.612780, -88.318429, '', ''],
    ['bld-eagle-gallery',   'Clara M. Eagle Gallery',                                        36.613158, -88.322286, '', ''],
    ['bld-el',              'Elizabeth College',                                              36.617174, -88.321999, '', ''],
    ['bld-ep',              'School of Engineering',                                         36.612114, -88.324838, '', ''],
    ['bld-fa',              'Doyle Fine Arts Center',                                        36.612984, -88.322288, '', ''],
    ['bld-facilities',      'Facilities Management Complex',                                 36.618403, -88.318197, '', ''],
    ['bld-fh',              'Faculty Hall',                                                  36.613000, -88.323597, '', ''],
    ['bld-fr',              'HC Franklin College',                                           36.617276, -88.320724, '', ''],
    ['bld-gage-track',      'Marshall Gage Track',                                           36.620700, -88.317796, '', ''],
    ['bld-golf',            'Indoor Golf Training Facility',                                 36.621611, -88.318418, '', ''],
    ['bld-ha',              'E.B. Howton Agricultural Engineering Building',                 36.615206, -88.323980, '', ''],
    ['bld-he',              'Hester College',                                                36.619530, -88.321882, '', ''],
    ['bld-heritage',        'Heritage Hall',                                                 36.622321, -88.323832, '', ''],
    ['bld-hogancamp',       'Hogancamp General Services Building',                           36.617206, -88.317962, '', ''],
    ['bld-ht',              'Hart College',                                                  36.618304, -88.320922, '', ''],
    ['bld-intramural',      'Intramural Fields',                                             36.618390, -88.323630, '', ''],
    ['bld-it',              'Collins Industry and Technology Center',                         36.615712, -88.322748, '', ''],
    ['bld-johnson-theatre', 'Robert E. Johnson Theatre',                                     36.612856, -88.322180, '', ''],
    ['bld-la',              'Lovett Auditorium',                                             36.613011, -88.322743, '', ''],
    ['bld-lc',              'Lowry Center',                                                  36.611575, -88.322262, '', ''],
    ['bld-learning-commons','Learning Commons',                                              36.619574, -88.320340, '', ''],
    ['bld-mh',              'Mason Hall',                                                    36.614696, -88.319614, '', ''],
    ['bld-nash',            'Nash House',                                                    36.611581, -88.324721, '', ''],
    ['bld-nursing',         'School of Nursing and Health Professions',                      36.613827, -88.323698, '', ''],
    ['bld-oakhurst',        'Oakhurst',                                                      36.610114, -88.323107, '', ''],
    ['bld-old-fa',          'Old Fine Arts',                                                 36.613432, -88.322452, '', ''],
    ['bld-pl',              'Pogue Library',                                                 36.611980, -88.322252, '', ''],
    ['bld-police',          'Murray State Police Department',                                36.616386, -88.323946, '', ''],
    ['bld-purcell-tennis',  'Bennie Purcell Tennis Courts',                                  36.616437, -88.319258, '', ''],
    ['bld-quad',            'The Quad',                                                      36.612402, -88.323023, '', ''],
    ['bld-racer-arena',     'Racer Arena',                                                   36.614502, -88.320572, '', ''],
    ['bld-racer-field',     'Racer Field',                                                   36.620828, -88.319152, '', ''],
    ['bld-ray-center',      'Gene W. Ray Center',                                            36.623204, -88.320009, '', ''],
    ['bld-re',              'Regents College',                                               36.615828, -88.318266, '', ''],
    ['bld-reagan-field',    'Johnny Reagan Field',                                           36.623314, -88.317361, '', ''],
    ['bld-rifle-range',     'Pat Spurgin Rifle Range',                                       36.621896, -88.318381, '', ''],
    ['bld-rx',              'Richmond College',                                              36.619654, -88.322471, '', ''],
    ['bld-sh',              'Sparks Hall',                                                   36.610096, -88.322560, '', ''],
    ['bld-sm',              'Simpson Child Development Center',                              36.613807, -88.320584, '', ''],
    ['bld-sorority',        'Sorority Suites',                                               36.608000, -88.323620, '', ''],
    ['bld-starbucks',       'Starbucks',                                                     36.615766, -88.321598, '', ''],
    ['bld-stadium-weight',  'Roy Stewart Stadium Weight Room',                               36.620792, -88.318364, '', ''],
    ['bld-stewart-stadium', 'Roy Stewart Stadium',                                           36.621353, -88.317365, '', ''],
    ['bld-tennis',          'Tennis Courts',                                                 36.619403, -88.323619, '', ''],
    ['bld-univ-club',       'University Club',                                               36.613689, -88.320245, '', ''],
    ['bld-univ-store',      'University Store',                                              36.615744, -88.321104, '', ''],
    ['bld-va',              'Visual Arts Building',                                          36.614102, -88.322765, '', ''],
    ['bld-we',              'Wells Hall',                                                    36.612407, -88.323633, '', ''],
    ['bld-weaver',          'Weaver Center',                                                 36.621005, -88.318435, '', ''],
    ['bld-wellness',        'Susan E. Bauernfeind Student Recreation and Wellness Center',   36.620908, -88.320458, '', ''],
    ['bld-white',           'RH White College',                                              36.615399, -88.317891, '', ''],
    ['bld-wi',              'Wilson Hall',                                                   36.611074, -88.322635, '', ''],
    ['bld-winslow',         'Winslow Dining Hall',                                           36.618292, -88.321820, '', ''],
    ['bld-wl',              'Waterfield Library',                                            36.613519, -88.321449, '', ''],
    ['bld-woods-park',      'Woods Park',                                                    36.612972, -88.320583, '', ''],
    ['bld-wr',              'Wrather Hall',                                                  36.611036, -88.323718, '', '']
  ];
}

/**
 * Per-building v2 fields. Buildings not listed get code '', number '',
 * hasIndoor false (outdoor map marker only).
 * number is the university facilities building number from the CAD title block.
 */
function getBuildingOverrides_() {
  return {
    'bld-it': { code: 'IT', number: '0135', hasIndoor: true },
    'bld-ep': { name: 'Engineering and Physics Building', code: 'EP', number: '0174', hasIndoor: true }
  };
}

/**
 * @return {Array} Building rows in v2 header order:
 *   [id, name, code, number, lat, lng, entrances, photoUrl, hasIndoor, levels, height]
 * levels and height come from the campus-map build (SeedCampusMap.gs, getGeneratedBuildingLevels), blank without it.
 */
function getBuildingsSeedRows_() {
  var base = getBuildingsBaseRows_();
  var overrides = getBuildingOverrides_();
  var levels = typeof getGeneratedBuildingLevels === 'function' ? (getGeneratedBuildingLevels() || {}) : {};
  var rows = [];
  for (var i = 0; i < base.length; i++) {
    var b = base[i];
    var o = overrides[b[0]] || {};
    var lv = levels.hasOwnProperty(b[0]) ? levels[b[0]] : ['', ''];
    rows.push([
      b[0],
      o.name || b[1],
      o.code || '',
      o.number || '',
      b[2],
      b[3],
      b[4],
      b[5],
      o.hasIndoor === true,
      lv[0],
      lv[1]
    ]);
  }
  return rows;
}

/**
 * The generated NavNodes rows (SeedFloorData.gs: id .. linkId, access) as sheet rows. An entrance takes the access
 * class the campus-map build chose (SeedCampusMap.gs, getGeneratedEntranceAccess: the primary-entrance heuristic's
 * doors main, other exterior doors alt, stair-tower exits emergency), else the pipeline's.
 */
function getNavNodesSeedRows_() {
  var rows = generatedRows_('getGeneratedNavNodesSeed');
  var cls = typeof getGeneratedEntranceAccess === 'function' ? (getGeneratedEntranceAccess() || {}) : {};
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var access = r[4] === 'entrance' && cls[r[0]] ? cls[r[0]] : r[7];
    out.push(r.slice(0, 7).concat([access === undefined || access === null ? '' : access]));
  }
  return out;
}

/**
 * Which generated floor seed is present: 'generated', 'placeholder-empty', or 'absent'.
 */
function floorSeedSource_() {
  if (typeof getGeneratedFloorsSeed !== 'function') return 'absent';
  var floors = getGeneratedFloorsSeed();
  return floors && floors.length ? 'generated' : 'placeholder-empty';
}

/**
 * Calls a generated seed function by name when it exists ([] otherwise), followed by its private counterpart from
 * SeedFloorDataPrivate.gs (the hidden floors, never committed) when the local admin has loaded that file.
 */
function generatedRows_(fnName) {
  var fns = {
    getGeneratedFloorsSeed: typeof getGeneratedFloorsSeed === 'function' ? getGeneratedFloorsSeed : null,
    getGeneratedRoomsSeed: typeof getGeneratedRoomsSeed === 'function' ? getGeneratedRoomsSeed : null,
    getGeneratedNavNodesSeed: typeof getGeneratedNavNodesSeed === 'function' ? getGeneratedNavNodesSeed : null,
    getGeneratedNavEdgesSeed: typeof getGeneratedNavEdgesSeed === 'function' ? getGeneratedNavEdgesSeed : null
  };
  var privateFns = {
    getGeneratedFloorsSeed: typeof getPrivateFloorsSeed === 'function' ? getPrivateFloorsSeed : null,
    getGeneratedRoomsSeed: typeof getPrivateRoomsSeed === 'function' ? getPrivateRoomsSeed : null,
    getGeneratedNavNodesSeed: typeof getPrivateNavNodesSeed === 'function' ? getPrivateNavNodesSeed : null,
    getGeneratedNavEdgesSeed: typeof getPrivateNavEdgesSeed === 'function' ? getPrivateNavEdgesSeed : null
  };
  var fn = fns[fnName];
  var more = privateFns[fnName];
  var rows = fn ? (fn() || []) : [];
  return more ? rows.concat(more() || []) : rows;
}

/**
 * The seed datasets, in write order, as { name, rows }.
 */
function getSeedDatasets_() {
  return [
    { name: 'Buildings', rows: getBuildingsSeedRows_() },
    { name: 'Floors', rows: generatedRows_('getGeneratedFloorsSeed') },
    { name: 'Rooms', rows: generatedRows_('getGeneratedRoomsSeed') },
    { name: 'NavNodes', rows: getNavNodesSeedRows_() },
    { name: 'NavEdges', rows: generatedRows_('getGeneratedNavEdgesSeed') }
  ];
}

/**
 * Writes seed data to every seeded tab that has no data rows (header only).
 * Validates every dataset against the v2 header width before writing anything,
 * so a malformed generated file fails loudly without a half-seeded sheet.
 *
 * @param {Spreadsheet} ss - The backing spreadsheet.
 * @return {Object} Rows written per tab; tabs that already had data report 'kept'.
 */
function seedAllCampusData(ss) {
  if (!ss || typeof ss.getSheetByName !== 'function') {
    throw new Error('seedAllCampusData needs the backing spreadsheet; call initSystem() instead.');
  }
  var datasets = getSeedDatasets_();
  for (var v = 0; v < datasets.length; v++) {
    validateSeedRows_(datasets[v].name, datasets[v].rows);
  }

  var result = {};
  for (var i = 0; i < datasets.length; i++) {
    var ds = datasets[i];
    var sheet = ss.getSheetByName(ds.name);
    if (!sheet) {
      result[ds.name] = 'missing-tab';
    } else if (sheet.getLastRow() > 1) {
      result[ds.name] = 'kept';
    } else {
      writeRows_(sheet, getSheetDefinition_(ds.name), ds.rows);
      result[ds.name] = ds.rows.length;
    }
  }
  return result;
}

/** Throws when a dataset's rows do not match its tab's v2 header width. */
function validateSeedRows_(name, rows) {
  var def = getSheetDefinition_(name);
  var width = def.headers.length;
  var seen = {};
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    if (!row || row.length !== width) {
      throw new Error('Seed ' + name + ' row ' + (r + 1) + ' has ' + (row ? row.length : 0) +
        ' columns; contract v2 expects ' + width + ' (' + def.headers.join(', ') + ').');
    }
    if (!row[0]) {
      throw new Error('Seed ' + name + ' row ' + (r + 1) + ' has no id.');
    }
    if (seen[row[0]]) {
      throw new Error('Seed ' + name + ' has a duplicate id: ' + row[0]);
    }
    seen[row[0]] = true;
    for (var c = 0; c < width; c++) {
      if (typeof row[c] === 'string' && row[c].length > 49000) {
        throw new Error('Seed ' + name + ' row ' + row[0] + ' column ' + def.headers[c] +
          ' exceeds the 50,000-character Sheets cell limit.');
      }
    }
  }
}

/**
 * Normalizes and writes rows below the header (text columns as strings, JSON
 * columns stringified, boolean columns as booleans). Applies text formats first.
 */
function writeRows_(sheet, def, rows) {
  if (!rows.length) return;
  var out = [];
  for (var r = 0; r < rows.length; r++) {
    out.push(normalizeRow_(def, rows[r]));
  }
  rewriteRows_(sheet, def, out); // AdminAPI.gs: grows the sheet and applies text formats
}

/** Converts one row array to its stored form per the tab definition. */
function normalizeRow_(def, row) {
  var out = [];
  for (var c = 0; c < def.headers.length; c++) {
    out.push(toCell_(def, def.headers[c], row[c]));
  }
  return out;
}

/** Converts one value to its stored cell form for column h of tab def. */
function toCell_(def, h, v) {
  if (v === undefined || v === null) return '';
  if (def.json && def.json.indexOf(h) !== -1) {
    return typeof v === 'string' ? v : JSON.stringify(v);
  }
  if (def.bools && def.bools.hasOwnProperty(h)) {
    if (v === '') return '';
    return toBool_(v, def.bools[h]);
  }
  if (def.text && def.text.indexOf(h) !== -1) {
    return String(v);
  }
  return v;
}

/** Interprets true/'true'/'TRUE'/1/'1'/'yes' as true; blank uses the default. */
function toBool_(v, dflt) {
  if (v === true || v === false) return v;
  if (v === '' || v === null || v === undefined) return dflt;
  var s = String(v).toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return dflt;
}
