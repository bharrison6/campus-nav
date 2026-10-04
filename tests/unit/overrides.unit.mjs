// The overrides layer's pure merge and diff (scripts/data/overrides.mjs) on hand-countable data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOverrides, canonical, diffOverrides, formatOverrides, orphanRecords, validateOverrides,
} from '../../scripts/data/overrides.mjs';

const headers = {
  buildings: ['id', 'name', 'code', 'entrances'],
  floors: ['id', 'buildingId', 'level'],
  rooms: ['id', 'floorId', 'number', 'label', 'polygon', 'searchable'],
  navNodes: ['id', 'floorId', 'x', 'y'],
  navEdges: ['id', 'fromNodeId', 'toNodeId'],
  photos: ['id', 'caption'],
  qrLocations: ['id', 'nodeId', 'description'],
  config: ['key', 'value'],
};

const base = () => ({
  buildings: [{ id: 'bld-it', name: 'Industry and Technology', code: 'IT', entrances: [{ lat: 1, lng: 2 }] }],
  floors: [{ id: 'floor-it-1', buildingId: 'bld-it', level: 1 }],
  rooms: [
    { id: 'room-a', floorId: 'floor-it-1', number: '0141', label: '141', polygon: [[0, 0], [1, 0], [1, 1]], searchable: true },
    { id: 'room-b', floorId: 'floor-it-1', number: '0142', label: '142', polygon: [[2, 0], [3, 0], [3, 1]], searchable: true },
    { id: 'room-c', floorId: 'floor-it-1', number: '0143', label: '143', polygon: [], searchable: false },
  ],
  navNodes: [{ id: 'n1', floorId: 'floor-it-1', x: 0, y: 0 }],
  navEdges: [],
  photos: [],
  qrLocations: [],
  config: [{ key: 'dataVersion', value: '1' }],
});

test('a partial edit merges over the base record; untouched fields and records stay', () => {
  const { data, report } = applyOverrides(base(), { rooms: [{ id: 'room-a', label: "Dean's Office" }] }, headers);
  assert.deepEqual(data.rooms[0], { ...base().rooms[0], label: "Dean's Office" });
  assert.deepEqual(data.rooms.slice(1), base().rooms.slice(1));
  assert.deepEqual(report.applied, { rooms: { edited: 1, added: 0, deleted: 0 } });
  assert.deepEqual(report.orphans, []);
});

test('_delete removes; _new adds with every column (blank when not given), after the base records', () => {
  const { data, report } = applyOverrides(base(), {
    rooms: [{ id: 'room-b', _delete: true }],
    qrLocations: [{ id: 'qr-1', _new: true, nodeId: 'n1' }],
  }, headers);
  assert.deepEqual(data.rooms.map((r) => r.id), ['room-a', 'room-c']);
  assert.deepEqual(data.qrLocations, [{ id: 'qr-1', nodeId: 'n1', description: '' }]);
  assert.deepEqual(report.applied, { rooms: { edited: 0, added: 0, deleted: 1 }, qrLocations: { edited: 0, added: 1, deleted: 0 } });
});

test('an edit or delete whose id left the base is an orphan: reported, skipped, and kept for the file', () => {
  const ov = {
    rooms: [{ id: 'room-gone', label: 'x' }, { id: 'room-gone-2', _delete: true }, { id: 'room-a', label: 'ok' }],
  };
  const { data, report } = applyOverrides(base(), ov, headers);
  assert.deepEqual(report.orphans, [
    { collection: 'rooms', id: 'room-gone', op: 'edit' },
    { collection: 'rooms', id: 'room-gone-2', op: 'delete' },
  ]);
  assert.equal(data.rooms.length, 3);
  assert.equal(data.rooms.find((r) => r.id === 'room-gone'), undefined, 'no half record is created');
  assert.equal(data.rooms[0].label, 'ok', 'the rest of the file still applies');
  assert.deepEqual(orphanRecords(ov, report), { rooms: ov.rooms.slice(0, 2) });
});

test('_new for an id the base now has merges over it and says so', () => {
  const { data, report } = applyOverrides(base(), { rooms: [{ id: 'room-c', _new: true, label: 'Added earlier' }] }, headers);
  assert.equal(data.rooms.find((r) => r.id === 'room-c').label, 'Added earlier');
  assert.equal(data.rooms.find((r) => r.id === 'room-c').number, '0143');
  assert.deepEqual(report.newInBase, [{ collection: 'rooms', id: 'room-c' }]);
});

test('config is keyed by key; mapsApiKey and dataVersion are refused; unknown fields are ignored and reported', () => {
  const { data, report } = applyOverrides(base(), {
    config: [{ key: 'campusName', _new: true, value: 'Murray State' }, { key: 'mapsApiKey', _new: true, value: 'AIzaX' }, { key: 'dataVersion', value: '9' }],
    rooms: [{ id: 'room-a', area: 12 }],
  }, headers);
  assert.deepEqual(data.config, [{ key: 'dataVersion', value: '1' }, { key: 'campusName', value: 'Murray State' }]);
  assert.deepEqual(report.refused.map((r) => r.id), ['mapsApiKey', 'dataVersion']);
  assert.deepEqual(report.ignoredFields, [{ collection: 'rooms', id: 'room-a', field: 'area' }]);
  assert.ok(!JSON.stringify(data).includes('AIza'));
});

test('malformed overrides fail loudly', () => {
  assert.throws(() => validateOverrides({ rooms: {} }), /must be an array/);
  assert.throws(() => validateOverrides({ rooms: [{ label: 'x' }] }), /"id" \(a non-empty string\) is required/);
  assert.throws(() => validateOverrides({ config: [{ id: 'x' }] }), /"key"/);
  assert.throws(() => validateOverrides({ rooms: [{ id: 'a', _new: true, _delete: true }] }), /together/);
  assert.throws(() => validateOverrides({ classrooms: [] }), /unknown collection/);
});

test('diff: identical data gives empty files; edits, adds and deletes round-trip through apply', () => {
  const empty = diffOverrides(base(), base(), headers);
  for (const recs of Object.values(empty)) assert.deepEqual(recs, []);

  const cur = base();
  cur.rooms[1].label = '142 Lab';
  cur.rooms[0].polygon = [[0, 0], [2, 0], [2, 2]];
  cur.rooms.splice(2, 1);
  cur.buildings[0].entrances = [{ lng: 2, lat: 1 }]; // same value, other key order: not a change
  cur.qrLocations.push({ id: 'qr-9', nodeId: 'n1', description: 'Lobby' });
  cur.config[0].value = '7'; // dataVersion moves with every admin write; never an override
  const d = diffOverrides(base(), cur, headers);
  assert.deepEqual(d.rooms, [
    { id: 'room-a', polygon: [[0, 0], [2, 0], [2, 2]] },
    { id: 'room-b', label: '142 Lab' },
    { id: 'room-c', _delete: true },
  ]);
  assert.deepEqual(d.qrLocations, [{ id: 'qr-9', _new: true, nodeId: 'n1', description: 'Lobby' }]);
  assert.deepEqual(d.buildings, []);
  assert.deepEqual(d.config, []);
  const { data } = applyOverrides(base(), d, headers);
  cur.config[0].value = '1';
  assert.equal(canonical(data), canonical(cur));
});

test('diff keeps orphans, sorts by id, and orders fields by the header', () => {
  const cur = base();
  cur.rooms[0].searchable = false;
  cur.rooms[0].label = 'L';
  const d = diffOverrides(base(), cur, headers, { rooms: [{ id: 'room-0-gone', label: 'kept' }] });
  assert.deepEqual(d.rooms, [{ id: 'room-0-gone', label: 'kept' }, { id: 'room-a', label: 'L', searchable: false }]);
  assert.deepEqual(Object.keys(d.rooms[1]), ['id', 'label', 'searchable']);
});

test('apply and diff are deterministic', () => {
  const ov = { rooms: [{ id: 'room-b', _delete: true }, { id: 'room-a', label: 'x' }] };
  assert.equal(canonical(applyOverrides(base(), ov, headers)), canonical(applyOverrides(base(), ov, headers)));
  const cur = applyOverrides(base(), ov, headers).data;
  assert.equal(JSON.stringify(diffOverrides(base(), cur, headers)), JSON.stringify(diffOverrides(base(), cur, headers)));
});

test('files: one record per line, an empty collection is []', () => {
  assert.equal(formatOverrides([]), '[]\n');
  assert.equal(formatOverrides([{ id: 'a', label: 'x' }, { id: 'b', _delete: true }]),
    '[\n  {"id":"a","label":"x"},\n  {"id":"b","_delete":true}\n]\n');
});
