import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInclude, loadFixture } from './load-include.mjs';

const S = loadInclude('WebApp_Search.html', 'MSCNSearch');
const publicOnly = (f) => !(f.public === false || String(f.public).toLowerCase() === 'false');
const index = S.buildIndex(loadFixture(), { floorFilter: publicOnly });
const titles = (q, n) => Array.from(S.search(index, q, n)).map((e) => e.title);

test('tokens split code from number but keep room suffixes', () => {
  assert.deepEqual(Array.from(S.tokens('IT141')), ['it', '141']);
  assert.deepEqual(Array.from(S.tokens('it-0140B')), ['it', '140b']);
  assert.deepEqual(Array.from(S.tokens('  Engineering & Physics ')), ['engineering', 'and', 'physics']);
});

test('display number and use text', () => {
  assert.equal(S.displayNumber('0140B'), '140B');
  assert.equal(S.useText({ number: '0141', label: '141 Classroom' }), 'Classroom');
  assert.equal(S.useText({ number: '0141', label: '141' }), '');
  assert.equal(S.useText({ number: '0141', label: 'Dean Suite' }), 'Dean Suite');
});

test('"IT 141" finds the room first, in every spelling', () => {
  for (const q of ['IT 141', 'it141', 'IT-0141', '141', '0141']) {
    assert.equal(titles(q)[0], 'IT 141', q);
  }
});

test('suffix rooms and prefixes', () => {
  assert.equal(titles('140b')[0], 'IT 140B');
  const t = titles('IT 14', 20);
  assert.ok(t.includes('IT 141') && t.includes('IT 140B'));
  assert.ok(!t.includes('EP 132'));
});

test('a code from another building excludes the room', () => {
  assert.deepEqual(titles('EP 141'), []);
  assert.equal(titles('EP 132')[0], 'EP 132');
});

test('label words find rooms', () => {
  assert.equal(titles('robotics')[0], 'IT 143');
  const labs = titles('lab', 20);
  assert.ok(labs.includes('IT 143') && labs.includes('IT 241') && labs.includes('EP 132'));
  assert.deepEqual(titles('EP lab'), ['EP 132']);
});

test('buildings by name and code', () => {
  assert.equal(titles('engineering')[0], 'Engineering & Physics');
  assert.equal(titles('IT')[0], 'Industry and Technology');
  assert.equal(titles('library')[0], 'Waterfield Library');
});

test('hidden floors and unsearchable rooms stay out of results', () => {
  assert.deepEqual(titles('mezzanine'), []);
  assert.deepEqual(titles('301'), []);
  assert.deepEqual(titles('elevator'), []);
});

test('room results carry ids to open them', () => {
  const e = S.search(index, 'IT 241', 1)[0];
  assert.equal(e.kind, 'room');
  assert.equal(e.roomId, 'room-it-2-0241');
  assert.equal(e.floorId, 'floor-it-2');
  assert.equal(e.buildingId, 'bld-it');
  assert.match(e.subtitle, /Computer Lab/);
});

test('empty query returns nothing', () => {
  assert.deepEqual(titles('   '), []);
});
