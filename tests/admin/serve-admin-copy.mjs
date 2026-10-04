#!/usr/bin/env node
// Starts the local admin over a fresh copy of the editable data, for the admin browser test (tests/admin): the
// overrides, the campus-map directory and a sample hallway-suggestion file go to test-results/admin-e2e-data, so the
// test never writes the committed files. The test reads what the editors wrote from there.
//   node tests/admin/serve-admin-copy.mjs --port 8791
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(REPO, 'test-results', 'admin-e2e-data');

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(path.join(DATA, 'review'), { recursive: true });
fs.cpSync(path.join(REPO, 'data', 'overrides'), path.join(DATA, 'overrides'), { recursive: true });
fs.cpSync(path.join(REPO, 'data', 'campus-map'), path.join(DATA, 'campus-map'), { recursive: true, filter: (p) => !/[\\/]source([\\/]|$)/.test(p) });
fs.writeFileSync(path.join(DATA, 'review', 'corridor-candidates.json'), JSON.stringify([
  { roomId: 'room-it-1-0141', floorId: 'floor-it-1', label: '141', evidence: ['5 doors', 'the nav graph passes through'], confidence: 0.72 },
  { roomId: 'room-it-1-0116C', floorId: 'floor-it-1', label: '116C', evidence: ['narrow'], confidence: 0.41 },
], null, 1));

const { createAdmin } = await import('../../tools/admin/server.mjs');
const i = process.argv.indexOf('--port');
const port = Number(i > -1 ? process.argv[i + 1] : 8791);
const admin = createAdmin({ overridesDir: path.join(DATA, 'overrides'), campusMapDir: path.join(DATA, 'campus-map'), reviewDir: path.join(DATA, 'review') });
admin.server.listen(port, '127.0.0.1', () => console.log(`[admin-e2e] admin over ${path.relative(REPO, DATA)} on http://localhost:${port}/`));
