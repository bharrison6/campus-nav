/**
 * SeedData.gs — Campus building, floor, and room seed data
 * for Murray State University.
 *
 * 89 building coordinates sourced from campus-maps.com interactive map.
 * Room data extracted from EP and IT floor plan PDFs.
 */

/**
 * Returns seed data for all 89 campus buildings.
 * Each row: [id, name, lat, lng, entrances, photoUrl]
 */
function _getBuildingsSeedData() {
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
 * Returns seed data for floors with floor plan data.
 * Only EP and IT have floor plans; other buildings are map markers only.
 * Each row: [id, buildingId, level, label, planImageUrl, widthPx, heightPx, metersPerPixel]
 */
function _getFloorsSeedData() {
  return [
    ['floor-ep-1', 'bld-ep', 1, '1st Floor', 'https://drive.google.com/file/d/1ZiY0elQQWgTPjxQIUPNuYuLtA1iSgTOw/view', 1404, 921, '0.045'],
    ['floor-ep-2', 'bld-ep', 2, '2nd Floor', 'https://drive.google.com/file/d/14njXbeWiq8y5VqedK08O2F7PMkTTCORR/view', 1469, 962, '0.045'],
    ['floor-it-1', 'bld-it', 1, '1st Floor', 'https://drive.google.com/file/d/1aRrMmSnr696JiI9FlSGbz2Q-MPxsVNbU/view', 1714, 1127, '0.040'],
    ['floor-it-2', 'bld-it', 2, '2nd Floor', 'https://drive.google.com/file/d/1pVW0MIXXIyYvdetAaJfl7wFqG87E_yb3/view', 1714, 1084, '0.040']
  ];
}

/**
 * Returns seed data for rooms extracted from floor plan PDFs.
 * centerX, centerY populated from PDF text extraction (EP) and visual estimation (IT).
 * polygon left blank — drawn via Room Polygon Editor.
 * Each row: [id, floorId, number, label, polygon, centerX, centerY]
 */
function _getRoomsSeedData() {
  return [
    // ── EP Floor 1 (19 rooms) ──────────────────────────────────────────
    ['room-ep-1-1301',      'floor-ep-1', 'EP 1301',   'Classroom',                        '', '863', '248'],
    ['room-ep-1-1303',      'floor-ep-1', 'EP 1303',   'Lecture Hall',                      '', '659', '236'],
    ['room-ep-1-1330',      'floor-ep-1', 'EP 1330',   'Fluid Mechanics Lab',               '', '582', '353'],
    ['room-ep-1-1331',      'floor-ep-1', 'EP 1331',   'Senior Design Lab',                 '', '732', '500'],
    ['room-ep-1-1340',      'floor-ep-1', 'EP 1340',   'Classroom',                        '', '882', '377'],
    ['room-ep-1-1346',      'floor-ep-1', 'EP 1346',   'E&M Physics Lab',                   '', '888', '549'],
    ['room-ep-1-1347',      'floor-ep-1', 'EP 1347',   'Mechanics Physics Lab',             '', '729', '647'],
    ['room-ep-1-1355',      'floor-ep-1', 'EP 1355',   'Standards & Digital Electronics Lab','', '1048', '728'],
    ['room-ep-1-highbay',   'floor-ep-1', 'HIGH BAY',  'Engineering Systems Lab',           '', '556', '495'],
    ['room-ep-1-optics',    'floor-ep-1', 'OPTICS',    'Optics Classroom/Lab',              '', '754', '806'],
    ['room-ep-1-physics-ofc','floor-ep-1','PHYS OFC',  'Physics Faculty Offices',           '', '464', '250'],
    ['room-ep-1-ioe-ofc',   'floor-ep-1', 'IOE OFC',  'Institute of Engineering Office',   '', '1006', '326'],
    ['room-ep-1-egr-ofc',   'floor-ep-1', 'EGR OFC',  'Engineering Faculty Offices',       '', '1017', '586'],
    ['room-ep-1-conf',      'floor-ep-1', 'CONF',      'Conference Room',                   '', '1098', '419'],
    ['room-ep-1-study',     'floor-ep-1', 'STUDY',     'Student Study/Research',            '', '704', '342'],
    ['room-ep-1-jones',     'floor-ep-1', 'JONES',     'Jones Office',                      '', '1089', '308'],
    ['room-ep-1-claiborne', 'floor-ep-1', 'CLAIBORNE', 'Claiborne Office',                  '', '1085', '362'],
    ['room-ep-1-rr-m',      'floor-ep-1', 'RR-M',     'Men\'s Restroom',                   '', '869', '685'],
    ['room-ep-1-rr-w',      'floor-ep-1', 'RR-W',     'Women\'s Restroom',                 '', '441', '376'],

    // ── EP Floor 2 (24 rooms) ──────────────────────────────────────────
    ['room-ep-2-2301',       'floor-ep-2', 'EP 2301',   'Biology Classroom',                '', '907', '260'],
    ['room-ep-2-2303',       'floor-ep-2', 'EP 2303',   'Biology Lecture Hall',             '', '695', '259'],
    ['room-ep-2-2328',       'floor-ep-2', 'EP 2328',   'Physical Chemistry Lab',           '', '608', '379'],
    ['room-ep-2-2340',       'floor-ep-2', 'EP 2340',   'Biology Classroom',                '', '919', '396'],
    ['room-ep-2-2361',       'floor-ep-2', 'EP 2361',   'Astronomy Classroom and Lab',      '', '1109', '772'],
    ['room-ep-2-2371',       'floor-ep-2', 'EP 2371',   'Computer Classroom',               '', '1104', '367'],
    ['room-ep-2-boggess',    'floor-ep-2', 'BOGGESS',   'Boggess Science Resource Center',  '', '1109', '451'],
    ['room-ep-2-bio-ofc',    'floor-ep-2', 'BIO OFC',   'Biology Offices',                  '', '471', '258'],
    ['room-ep-2-thiede-lab', 'floor-ep-2', 'THIEDE',    'Thiede Research Lab',              '', '773', '492'],
    ['room-ep-2-bunget-lab', 'floor-ep-2', 'BUNGET',    'Bunget Research Lab',              '', '767', '586'],
    ['room-ep-2-leedy-lab',  'floor-ep-2', 'LEEDY',     'Leedy Research Lab',               '', '773', '683'],
    ['room-ep-2-kobraei-lab','floor-ep-2', 'KOBRAEI',   'Kobraei Research Lab',             '', '943', '581'],
    ['room-ep-2-ridley-lab', 'floor-ep-2', 'RIDLEY',    'Ridley Research Lab',              '', '1116', '651'],
    ['room-ep-2-rogers-lab', 'floor-ep-2', 'ROGERS',    'Rogers Research Lab',              '', '878', '851'],
    ['room-ep-2-hereford-lab','floor-ep-2','HEREFORD',  'Hereford Research Lab',            '', '786', '854'],
    ['room-ep-2-cobb-lab',   'floor-ep-2', 'COBB',      'Cobb Research Lab',                '', '973', '852'],
    ['room-ep-2-williams-lab','floor-ep-2','WILLIAMS',  'Williams Research Lab',            '', '933', '469'],
    ['room-ep-2-woods',      'floor-ep-2', 'WOODS',     'Woods Lab',                        '', '1141', '558'],
    ['room-ep-2-research',   'floor-ep-2', 'RESEARCH',  'Research Lab',                     '', '943', '659'],
    ['room-ep-2-rapid-proto','floor-ep-2', 'RAPID',     'Rapid Prototype Center',           '', '615', '593'],
    ['room-ep-2-bio-res',    'floor-ep-2', 'BIO RES',   'Biology Research Labs',            '', '301', '555'],
    ['room-ep-2-chem-res',   'floor-ep-2', 'CHEM RES',  'Chemistry Research Lab',           '', '735', '355'],
    ['room-ep-2-rr-m',       'floor-ep-2', 'RR-M',      'Men\'s Restroom',                  '', '911', '728'],
    ['room-ep-2-rr-w',       'floor-ep-2', 'RR-W',      'Women\'s Restroom',                '', '1017', '423'],

    // ── IT Floor 1 (29 rooms) ──────────────────────────────────────────
    ['room-it-1-121',  'floor-it-1', '121',  'Materials and Process Lab',             '', '505', '426'],
    ['room-it-1-122',  'floor-it-1', '122',  'Phone Room',                            '', '405', '325'],
    ['room-it-1-123',  'floor-it-1', '123',  'Interior Design Studio',                '', '655', '427'],
    ['room-it-1-124',  'floor-it-1', '124',  'Architectural/Construction Design Lab', '', '805', '428'],
    ['room-it-1-125',  'floor-it-1', '125',  'Engineering Graphics and Design Lab',   '', '955', '429'],
    ['room-it-1-126',  'floor-it-1', '126',  'Emergency Medical Training Lab',        '', '1105', '380'],
    ['room-it-1-127',  'floor-it-1', '127',  'Design and Painting Lab',               '', '1255', '381'],
    ['room-it-1-130',  'floor-it-1', '130',  'Classroom/Student Lounge',              '', '704', '577'],
    ['room-it-1-131',  'floor-it-1', '131',  'OSH Lab',                               '', '554', '576'],
    ['room-it-1-132',  'floor-it-1', '132',  'Classroom',                             '', '853', '628'],
    ['room-it-1-133',  'floor-it-1', '133',  'Industrial Hygiene and Acoustics Lab',  '', '703', '677'],
    ['room-it-1-134',  'floor-it-1', '134',  'Machine Tool Processes',                '', '453', '675'],
    ['room-it-1-135',  'floor-it-1', '135',  'Fire Safety Lab',                       '', '354', '574'],
    ['room-it-1-141',  'floor-it-1', '141',  'Office',                                '', '1304', '461'],
    ['room-it-1-142',  'floor-it-1', '142',  'Office',                                '', '1354', '511'],
    ['room-it-1-144',  'floor-it-1', '144',  'Office',                                '', '1404', '462'],
    ['room-it-1-145',  'floor-it-1', '145',  'Office',                                '', '1454', '512'],
    ['room-it-1-146',  'floor-it-1', '146',  'OSH Training Center',                   '', '1204', '560'],
    ['room-it-1-147',  'floor-it-1', '147',  'Office',                                '', '1303', '611'],
    ['room-it-1-148',  'floor-it-1', '148',  'Office',                                '', '1353', '661'],
    ['room-it-1-149',  'floor-it-1', '149',  'Office',                                '', '1403', '612'],
    ['room-it-1-150',  'floor-it-1', '150',  'Office',                                '', '1453', '662'],
    ['room-it-1-153',  'floor-it-1', '153',  'Office',                                '', '1504', '563'],
    ['room-it-1-155',  'floor-it-1', '155',  'Classroom',                             '', '1102', '760'],
    ['room-it-1-156',  'floor-it-1', '156',  'Classroom',                             '', '952', '759'],
    ['room-it-1-157',  'floor-it-1', '157',  'Office Suite (Chair OSH)',              '', '1302', '811'],
    ['room-it-1-161',  'floor-it-1', '161',  'Office',                                '', '1202', '860'],
    ['room-it-1-rr-w', 'floor-it-1', 'RR-W', 'Women\'s Restroom',                    '', '1004', '459'],
    ['room-it-1-rr-m', 'floor-it-1', 'RR-M', 'Men\'s Restroom',                      '', '1054', '459'],

    // ── IT Floor 2 (30 rooms) ──────────────────────────────────────────
    ['room-it-2-215',  'floor-it-2', '215',  'Information Systems Operations',        '', '213', '381'],
    ['room-it-2-217',  'floor-it-2', '217',  'Grad Assistants',                       '', '212', '441'],
    ['room-it-2-221',  'floor-it-2', '221',  'Industrial Networks and Communications','', '363', '283'],
    ['room-it-2-222',  'floor-it-2', '222',  'Telecommunications Electronics',        '', '493', '283'],
    ['room-it-2-223',  'floor-it-2', '223',  'Network/Security Lab',                  '', '613', '284'],
    ['room-it-2-224',  'floor-it-2', '224',  'CyberCave',                             '', '733', '285'],
    ['room-it-2-225',  'floor-it-2', '225',  'Telecommunications Networking',          '', '863', '286'],
    ['room-it-2-226',  'floor-it-2', '226',  'Telephony/Wireless',                    '', '993', '287'],
    ['room-it-2-227',  'floor-it-2', '227',  'ICT Technician',                        '', '1113', '288'],
    ['room-it-2-228',  'floor-it-2', '228',  'ENV Research',                           '', '1013', '387'],
    ['room-it-2-229',  'floor-it-2', '229',  'Classroom',                             '', '572', '404'],
    ['room-it-2-230',  'floor-it-2', '230',  'General Computer Lab',                  '', '712', '405'],
    ['room-it-2-231',  'floor-it-2', '231',  'Fred M. Card Auditorium',               '', '494', '133'],
    ['room-it-2-233',  'floor-it-2', '233',  'Fluid Power and Motion Control',        '', '862', '406'],
    ['room-it-2-234',  'floor-it-2', '234',  'Environmental Lab',                     '', '462', '523'],
    ['room-it-2-235',  'floor-it-2', '235',  'Radio Comm. Lab',                       '', '612', '524'],
    ['room-it-2-237',  'floor-it-2', '237',  'Classroom',                             '', '762', '525'],
    ['room-it-2-241',  'floor-it-2', '241',  'Office',                                '', '1262', '409'],
    ['room-it-2-243',  'floor-it-2', '243',  'Classroom',                             '', '912', '526'],
    ['room-it-2-244',  'floor-it-2', '244',  'Power and Motor Control',               '', '1062', '527'],
    ['room-it-2-247',  'floor-it-2', '247',  'Student Lounge (IET)',                   '', '1312', '529'],
    ['room-it-2-253a', 'floor-it-2', '253A', 'Chair IET Office',                      '', '1362', '470'],
    ['room-it-2-253r', 'floor-it-2', '253R', 'Student Work Area',                     '', '1412', '530'],
    ['room-it-2-255',  'floor-it-2', '255',  'Computer Aided Design Lab',             '', '212', '521'],
    ['room-it-2-259',  'floor-it-2', '259',  'Computer Graphics Lab',                 '', '211', '641'],
    ['room-it-2-263a', 'floor-it-2', '263A', 'Student Lounge',                        '', '1361', '610'],
    ['room-it-2-251',  'floor-it-2', '251',  'Men\'s Restroom',                       '', '762', '465'],
    ['room-it-2-252',  'floor-it-2', '252',  'Women\'s Restroom',                     '', '812', '466'],
    ['room-it-2-242',  'floor-it-2', '242',  'Office',                                '', '1212', '458'],
    ['room-it-2-rr-w', 'floor-it-2', 'RR-W', 'Women\'s Restroom (South)',            '', '1011', '557']
  ];
}

/**
 * Writes all campus seed data to the Buildings, Floors, and Rooms sheets.
 * Idempotent: only writes if each sheet has no data rows (header-only).
 * Uses batch setValues() for efficiency.
 * @param {Spreadsheet} ss - The backing spreadsheet.
 */
function seedAllCampusData(ss) {
  var datasets = [
    { name: 'Buildings', getData: _getBuildingsSeedData },
    { name: 'Floors',    getData: _getFloorsSeedData },
    { name: 'Rooms',     getData: _getRoomsSeedData }
  ];

  for (var i = 0; i < datasets.length; i++) {
    var sheet = ss.getSheetByName(datasets[i].name);
    if (sheet && sheet.getLastRow() <= 1) {
      var rows = datasets[i].getData();
      if (rows.length > 0) {
        sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
      }
    }
  }
}
