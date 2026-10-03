// Polygon closing, units and frame change, and label matching on a synthetic normalized floor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeRing, extractFloor, labelFromNumber, parseAreaSf } from '../stages/extract.mjs';
import { area } from '../lib/geometry.mjs';

const floor = { file: 'x.dwg', floorId: 'floor-it-1', bldg: 'it', level: 1, label: 'First Floor', public: true };

const poly = (h, v, { closed = true, fm = null, L = 'AREA-ROOM' } = {}) => ({ t: 'poly', L, h, v: v.map(([x, y]) => [x, y, 0]), closed, fm });
const tag = (h, p, number, areaSf = '', layer = 'AREA-NUMB') => ({
  t: 'insert', L: layer, h, name: 'FMGRM1', p, sx: 1, sy: 1, rot: 0, mirror: false,
  attribs: {
    RMNUMB: { text: number, p }, RMDOOR: { text: '', p }, DATA1: { text: '', p }, DATA2: { text: '', p },
    DATA3: { text: '', p }, DATA4: { text: '', p }, DATA5: { text: '', p }, RMAREA: { text: areaSf, p },
  },
});

function syntheticFloor() {
  // Room A: 120 x 144 in = 120 sf, numbered by xdata, tag inside.
  // Room B: 120 x 120 in = 100 sf, no xdata, tag inside -> matched by position, closing edge implied (flag off).
  // Room C: no xdata, no tag -> synthetic UNK-1.
  // A stray tag with no polygon -> anomaly.
  return {
    source: 'x.dwg',
    header: { INSUNITS: 1 },
    entities: [
      poly('A', [[0, 0], [120, 0], [120, 144], [0, 144]], { fm: '0141' }),
      poly('B', [[200, 0], [320, 0], [320, 120], [200, 120]], { closed: false }),
      poly('C', [[400, 0], [460, 0], [460, 60], [400, 60]]),
      poly('G', [[-10, -10], [470, -10], [470, 160], [-10, 160]], { L: 'AREA-GROS' }),
      tag('t1', [60, 72], '0141', '120 sf'),
      tag('t2', [260, 60], '0140B', '100 sf'),
      tag('t3', [900, 900], '0199'),
      { t: 'line', L: 'A-BLDG', h: 'w1', p: [[0, 0], [120, 0]] },
      { t: 'line', L: 'BORDERLINE', h: 'b1', p: [[-5000, -5000], [5000, 5000]] },
    ],
    blocks: {},
  };
}

test('labels drop leading zeros only', () => {
  assert.equal(labelFromNumber('0141'), '141');
  assert.equal(labelFromNumber('0140B'), '140B');
  assert.equal(labelFromNumber('1315'), '1315');
  assert.equal(labelFromNumber('0000'), '0');
});

test('RMAREA parsing tolerates thousands separators', () => {
  assert.equal(parseAreaSf('1,190 sf'), 1190);
  assert.equal(parseAreaSf('75 sf'), 75);
  assert.equal(parseAreaSf(''), null);
});

test('closeRing: flag, coincident endpoints, implied closing edge', () => {
  const sq = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];
  assert.equal(closeRing({ v: sq, closed: true }).method, 'closed-flag');
  assert.equal(closeRing({ v: [...sq, [0, 0, 0]], closed: false }).method, 'coincident-endpoints');
  const implied = closeRing({ v: sq, closed: false });
  assert.equal(implied.method, 'implied-closing-edge');
  assert.equal(area(implied.ring), 100);
  assert.equal(implied.ring.length, 4);
});

test('extractFloor matches tags, flags anomalies, flips into the SVG frame', () => {
  const fp = extractFloor(syntheticFloor(), floor);
  const by = Object.fromEntries(fp.rooms.map((r) => [r.number, r]));
  assert.equal(fp.units.metersPerUnit, 0.0254);
  assert.match(fp.units.method, /INSUNITS=1/);
  assert.equal(by['0141'].matchedBy, 'xdata-number');
  assert.equal(by['0141'].label, '141');
  assert.equal(by['0140B'].matchedBy, 'tag-in-polygon');
  assert.equal(by['0140B'].label, '140B');
  assert.equal(by['0140B'].closure, 'implied-closing-edge');
  assert.ok(by['UNK-1'], 'untagged room gets a synthetic number');
  assert.ok(Math.abs(by['0141'].areaSf - 120) < 1e-6);
  const kinds = fp.anomalies.map((a) => a.kind);
  assert.ok(kinds.includes('tag-without-polygon'));
  assert.ok(kinds.includes('room-without-number'));
  // Frame: everything inside [0,width]x[0,height]; y flipped (room A's bottom edge, y=0 in DWG, is near the bottom).
  for (const r of fp.rooms) for (const [x, y] of r.polygon) assert.ok(x >= 0 && y >= 0 && x <= fp.width && y <= fp.height);
  const a = by['0141'];
  const maxY = Math.max(...a.polygon.map((p) => p[1]));
  assert.ok(maxY > fp.height - 60, 'DWG y=0 maps near the bottom of the SVG');
  // The border line (excluded layer) does not blow up the extents.
  assert.ok(fp.width < 600 && fp.height < 300);
});
