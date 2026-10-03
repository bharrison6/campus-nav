// Synthesizes a small campus in the Data contract v2 shape for the unit tests:
//   tests/unit/fixtures/campus-data.json  (shaped like getAllCampusData output)
//   tests/unit/fixtures/svg/FP_<floor>.svg (shaped like getFloorPlanSvg output)
// Small, deterministic, hand-checkable, and it carries room use text ("Robotics Lab") that the
// real CAD drawings lack, so search-by-label-words stays tested. The dev harness and the e2e
// suite use the real pipeline output instead (dev/serve.mjs runs the .gs files on SeedFloorData.gs).
//
// Coordinates follow the contract: DWG units (inches), floor extents start at (0,0), +y down.
// Run: node tests/unit/fixtures/build-fixtures.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MPP = 0.0254; // meters per DWG unit (inches)

const buildings = [
  {
    id: 'bld-it', name: 'Industry and Technology', code: 'IT', number: '0135',
    lat: 36.61612, lng: -88.32476,
    entrances: JSON.stringify([{ name: 'West Entrance', lat: 36.61608, lng: -88.32521, nodeId: 'node-it-1-entrance-w' }]),
    photoUrl: '', hasIndoor: true,
  },
  {
    id: 'bld-ep', name: 'Engineering & Physics', code: 'EP', number: '0174',
    lat: 36.61545, lng: -88.32402,
    entrances: JSON.stringify([{ name: 'North Entrance', lat: 36.61562, lng: -88.32405, nodeId: 'node-ep-1-entrance-n' }]),
    photoUrl: '', hasIndoor: true,
  },
  {
    id: 'bld-library', name: 'Waterfield Library', code: 'LIB', number: '0040',
    lat: 36.61680, lng: -88.31930, entrances: '[]', photoUrl: '', hasIndoor: false,
  },
];

// Floors: IT 1, IT 2, IT 3 (mezzanine, not public), EP 1.
const floorDefs = [
  { id: 'floor-it-1', buildingId: 'bld-it', level: 1, label: 'Floor 1', w: 2400, h: 1200, public: true },
  { id: 'floor-it-2', buildingId: 'bld-it', level: 2, label: 'Floor 2', w: 2400, h: 1200, public: true },
  { id: 'floor-it-3', buildingId: 'bld-it', level: 3, label: 'Mezzanine', w: 2400, h: 1200, public: false },
  { id: 'floor-ep-1', buildingId: 'bld-ep', level: 1, label: 'Floor 1', w: 1600, h: 900, public: true },
];

// Rooms as rectangles [x0, y0, x1, y1]; side tells which corridor wall the door is on.
const roomDefs = {
  'floor-it-1': [
    { n: '0141', use: 'Classroom', type: 'Classroom', r: [100, 100, 600, 500], side: 'S' },
    { n: '0143', use: 'Robotics Lab', type: 'Lab', r: [600, 100, 1200, 500], side: 'S' },
    { n: '0145', use: 'Office', type: 'Office', r: [1200, 100, 1600, 500], side: 'S' },
    { n: '0147', use: 'Machine Shop', type: 'Lab', r: [1600, 100, 2300, 500], side: 'S' },
    { n: '0140', use: 'Mechanical', type: 'Mechanical', r: [300, 700, 900, 1100], side: 'N' },
    { n: '0140B', use: 'Storage', type: 'Storage', r: [900, 700, 1300, 1100], side: 'N' },
    { n: '0142', use: 'Restroom', type: 'Restroom', r: [1300, 700, 1850, 1100], side: 'N' },
    { n: '0150', use: 'Elevator', type: 'Elevator', r: [1900, 700, 2050, 1100], side: 'N', searchable: false },
    { n: '0152', use: 'Stair 1', type: 'Stair', r: [100, 700, 300, 1100], side: 'N', searchable: false },
  ],
  'floor-it-2': [
    { n: '0241', use: 'Computer Lab', type: 'Lab', r: [100, 100, 700, 500], side: 'S' },
    { n: '0243', use: 'Conference Room', type: 'Conference', r: [700, 100, 1300, 500], side: 'S' },
    { n: '0245', use: 'Office', type: 'Office', r: [1300, 100, 2300, 500], side: 'S' },
    { n: '0240', use: 'Faculty Offices', type: 'Office', r: [300, 700, 1850, 1100], side: 'N' },
    { n: '0250', use: 'Elevator', type: 'Elevator', r: [1900, 700, 2050, 1100], side: 'N', searchable: false },
    { n: '0252', use: 'Stair 1', type: 'Stair', r: [100, 700, 300, 1100], side: 'N', searchable: false },
  ],
  'floor-it-3': [
    { n: '0301', use: 'Mechanical Mezzanine', type: 'Mechanical', r: [1500, 700, 2050, 1100], side: 'N' },
    { n: '0352', use: 'Stair 1', type: 'Stair', r: [100, 700, 300, 1100], side: 'N', searchable: false },
  ],
  'floor-ep-1': [
    { n: '0132', use: 'Physics Lab', type: 'Lab', r: [100, 450, 700, 800], side: 'N' },
    { n: '0134', use: 'Lecture Hall', type: 'Classroom', r: [700, 450, 1500, 800], side: 'N' },
    { n: '0130', use: 'Office', type: 'Office', r: [100, 100, 700, 300], side: 'S' },
  ],
};

const CORRIDOR_Y = { 'floor-it-1': 600, 'floor-it-2': 600, 'floor-it-3': 600, 'floor-ep-1': 375 };

const floors = [];
const rooms = [];
const navNodes = [];
const navEdges = [];
const nodeById = new Map();

function addNode(id, floorId, x, y, type, roomId = '', linkId = '') {
  const node = { id, floorId, x, y, type, roomId, linkId };
  navNodes.push(node);
  nodeById.set(id, node);
  return node;
}
function dist(a, b) {
  return Math.round(Math.hypot(a.x - b.x, a.y - b.y) * MPP * 100) / 100;
}
let edgeSeq = 0;
function addEdge(a, b, opts = {}) {
  const A = nodeById.get(a), B = nodeById.get(b);
  edgeSeq += 1;
  navEdges.push({
    id: `edge-${String(edgeSeq).padStart(3, '0')}`,
    fromNodeId: a, toNodeId: b,
    distance: opts.distance ?? dist(A, B),
    floorChange: A.floorId !== B.floorId,
    accessible: opts.accessible ?? true,
  });
}

for (const f of floorDefs) {
  const short = f.id.replace('floor-', ''); // it-1
  const [bld, level] = short.split('-');
  floors.push({
    id: f.id, buildingId: f.buildingId, level: f.level, label: f.label,
    planAsset: 'FP_' + f.id.replace(/-/g, '_'), widthPx: f.w, heightPx: f.h,
    metersPerPixel: MPP, public: f.public,
  });

  const cy = CORRIDOR_Y[f.id];
  // Corridor spine waypoints every 250 units.
  const spine = [];
  for (let x = 150; x <= f.w - 100; x += 250) {
    spine.push(addNode(`node-${short}-wp-${x}`, f.id, x, cy, 'waypoint'));
  }
  for (let i = 1; i < spine.length; i++) addEdge(spine[i - 1].id, spine[i].id);
  const nearestSpine = (x) => spine.reduce((best, n) => (Math.abs(n.x - x) < Math.abs(best.x - x) ? n : best));

  for (const rd of roomDefs[f.id]) {
    const id = `room-${bld}-${level}-${rd.n}`;
    const [x0, y0, x1, y1] = rd.r;
    const cx = (x0 + x1) / 2, cyR = (y0 + y1) / 2;
    const human = rd.n.replace(/^0+/, '');
    rooms.push({
      id, floorId: f.id, number: rd.n, label: `${human} ${rd.use}`, type: rd.type,
      polygon: JSON.stringify([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]),
      centerX: cx, centerY: cyR, searchable: rd.searchable === false ? false : true,
    });
    const doorY = rd.side === 'S' ? y1 : y0;
    if (rd.type === 'Stair' || rd.type === 'Elevator') {
      const type = rd.type === 'Stair' ? 'stair' : 'elevator';
      const link = type === 'stair' ? `${bld}-stair-1` : `${bld}-elevator-1`;
      const t = addNode(`node-${short}-${type}`, f.id, cx, cyR, type, id, link);
      const sp = nearestSpine(cx);
      addEdge(sp.id, t.id);
      continue;
    }
    const door = addNode(`node-${short}-door-${rd.n.toLowerCase()}`, f.id, cx, doorY, 'door', id);
    const room = addNode(`node-${short}-room-${rd.n.toLowerCase()}`, f.id, cx, cyR, 'room', id);
    addEdge(door.id, room.id);
    addEdge(nearestSpine(cx).id, door.id);
  }
}

// Entrances.
const itEnt = addNode('node-it-1-entrance-w', 'floor-it-1', 60, 600, 'entrance');
addEdge(itEnt.id, 'node-it-1-wp-150');
const epEnt = addNode('node-ep-1-entrance-n', 'floor-ep-1', 1150, 40, 'entrance');
addEdge(epEnt.id, 'node-ep-1-wp-1150');
// EP's entrance is on the north wall, past office 0130; connect through a short hall.
// (wp-1150 exists on the spine at x=1150.)

// Cross-floor links: IT stair 1->2->3 (not accessible), IT elevator 1<->2 (accessible).
addEdge('node-it-1-stair', 'node-it-2-stair', { distance: 8, accessible: false });
addEdge('node-it-2-stair', 'node-it-3-stair', { distance: 8, accessible: false });
addEdge('node-it-1-elevator', 'node-it-2-elevator', { distance: 12, accessible: true });

const photos = [
  { id: 'photo-it-1-lobby', type: 'indoor', buildingId: 'bld-it', floorId: 'floor-it-1', x: 250, y: 600,
    lat: '', lng: '', driveUrl: '', caption: 'IT west lobby (fixture, no image)', heading: 0 },
];

const qrLocations = [
  { id: 'qr-it-1-lobby', buildingId: 'bld-it', floorId: 'floor-it-1', nodeId: 'node-it-1-wp-400',
    description: 'IT first-floor lobby', permanent: true, expires: '', createdDate: '2026-10-03' },
];

const data = {
  version: 7,
  config: [{ key: 'dataVersion', value: 7 }],
  buildings, floors, rooms, navNodes, navEdges, photos, qrLocations,
};

// The sheet layer auto-parses JSON strings; mirror that so fixtures look like getAllCampusData output.
for (const b of data.buildings) b.entrances = JSON.parse(b.entrances);
for (const r of data.rooms) r.polygon = JSON.parse(r.polygon);

writeFileSync(join(here, 'campus-data.json'), JSON.stringify(data, null, 1) + '\n');

// SVGs: shaped like lane A's output (background, walls, <g id="rooms"> of <path data-room-id>).
mkdirSync(join(here, 'svg'), { recursive: true });
for (const f of floors) {
  const fr = rooms.filter((r) => r.floorId === f.id);
  const paths = fr.map((r) => {
    const d = 'M' + r.polygon.map((p) => p.join(' ')).join(' L') + ' Z';
    return `    <path data-room-id="${r.id}" d="${d}" fill="#ffffff" stroke="#222222" stroke-width="4"/>`;
  });
  const cy = CORRIDOR_Y[f.id];
  const walls = [
    `    <rect x="40" y="40" width="${f.widthPx - 80}" height="${f.heightPx - 80}" fill="none" stroke="#111111" stroke-width="12"/>`,
    `    <line x1="100" y1="${cy - 100}" x2="${f.widthPx - 100}" y2="${cy - 100}" stroke="#111111" stroke-width="6"/>`,
    `    <line x1="100" y1="${cy + 100}" x2="${f.widthPx - 100}" y2="${cy + 100}" stroke="#111111" stroke-width="6"/>`,
  ];
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f.widthPx} ${f.heightPx}" width="${f.widthPx}" height="${f.heightPx}" data-floor-id="${f.id}">`,
    `  <g id="background"><rect x="0" y="0" width="${f.widthPx}" height="${f.heightPx}" fill="#f4f4f2"/></g>`,
    '  <g id="walls">',
    ...walls,
    '  </g>',
    '  <g id="rooms">',
    ...paths,
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
  writeFileSync(join(here, 'svg', f.planAsset + '.svg'), svg);
}

console.log(`wrote ${floors.length} floors, ${rooms.length} rooms, ${navNodes.length} nodes, ${navEdges.length} edges`);
