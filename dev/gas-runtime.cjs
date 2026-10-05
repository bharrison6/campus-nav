// Apps Script runtime stand-in for running the backend .gs files (tools/admin/gs) in Node.
//
//   const { makeRuntime, GS_DIR } = require('./gas-runtime.cjs');
//   const gas = makeRuntime();                 // every .gs file in GS_DIR evaluated in one VM context, as GAS does
//   gas.ctx.initSystem();                      // creates the in-memory spreadsheet and seeds it
//   gas.run('getAllCampusData', []);           // what google.script.run would return (JSON-shaped)
//
//   makeRuntime(srcDir = GS_DIR, extraCode, { htmlDirs, gsDirs })
//     srcDir    folder of .gs files (and the FP_*.html floor-plan assets HtmlService reads)
//     extraCode code evaluated after the .gs files (tests override generated seeds this way)
//     htmlDirs  further folders HtmlService looks in, after srcDir, for project HTML files
//     gsDirs    further folders whose .gs files are evaluated after srcDir's, before extraCode (the hidden floors'
//               private seed, SeedFloorDataPrivate.gs, for the local admin)
//
// Models what the backend relies on: SpreadsheetApp (tabs, ranges, getValues/setValues with the
// Sheets coercion of numeric and boolean strings unless the column is plain text '@', the
// 50,000-character cell limit, row bounds), PropertiesService, CacheService, LockService, Utilities
// (digest, uuid, blob bytes) and HtmlService (project HTML files: the floor-plan assets). Started as
// lane B's mock (2026-10-03). Since v3 (static site) the .gs files are no longer deployed anywhere: this
// runtime is their only engine, used by the build-time export (scripts/data/export-campus-data.mjs), the
// local admin (tools/admin/server.mjs) and tests/unit.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const CELL_LIMIT = 50000;
/** The backend's home since v3. */
const GS_DIR = path.resolve(__dirname, '..', 'tools', 'admin', 'gs');

function makeRuntime(srcDir, extraCode, opts) {
  srcDir = srcDir || GS_DIR;
  const htmlDirs = [srcDir].concat((opts && opts.htmlDirs) || []);
  const props = {};
  const cache = {};

  class Sheet {
    constructor(name) { this.name = name; this.rows = []; this.maxRows = 1000; this.textCols = {}; }
    getName() { return this.name; }
    getMaxRows() { return this.maxRows; }
    insertRowsAfter(after, n) { this.maxRows += n; }
    getLastRow() {
      for (let r = this.rows.length - 1; r >= 0; r--) {
        if (this.rows[r] && this.rows[r].some((v) => v !== '' && v !== undefined)) return r + 1;
      }
      return 0;
    }
    getLastColumn() {
      let m = 0;
      for (const row of this.rows) {
        if (!row) continue;
        for (let c = row.length - 1; c >= 0; c--) {
          if (row[c] !== '' && row[c] !== undefined) { m = Math.max(m, c + 1); break; }
        }
      }
      return m;
    }
    getRange(r, c, nr = 1, nc = 1) {
      if (r + nr - 1 > this.maxRows) throw new Error('Range out of bounds: row ' + (r + nr - 1) + ' > maxRows ' + this.maxRows);
      return new Range(this, r, c, nr, nc);
    }
    getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
    appendRow(vals) { this.getRange(this.getLastRow() + 1, 1, 1, vals.length).setValues([vals]); }
    deleteRow(i) { this.rows.splice(i - 1, 1); }
    setFrozenRows() {}
  }

  class Range {
    constructor(s, r, c, nr, nc) { Object.assign(this, { s, r, c, nr, nc }); }
    getValues() {
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = this.s.rows[this.r - 1 + i] || [];
        const o = [];
        for (let j = 0; j < this.nc; j++) { const v = row[this.c - 1 + j]; o.push(v === undefined ? '' : v); }
        out.push(o);
      }
      return out;
    }
    setValues(vals) {
      if (vals.length !== this.nr || vals[0].length !== this.nc) {
        throw new Error(`setValues dims ${vals.length}x${vals[0].length} != ${this.nr}x${this.nc}`);
      }
      for (let i = 0; i < this.nr; i++) {
        const ri = this.r - 1 + i;
        this.s.rows[ri] = this.s.rows[ri] || [];
        for (let j = 0; j < this.nc; j++) {
          let v = vals[i][j];
          const col = this.c + j;
          if (v instanceof Object && !(v instanceof Date)) throw new Error('Object written to cell');
          if (typeof v === 'string' && v.length > CELL_LIMIT) {
            throw new Error(`Your input contains more than the maximum of ${CELL_LIMIT} characters in a single cell (${this.s.name} row ${ri + 1}).`);
          }
          const text = ri >= 1 && this.s.textCols[col];
          if (typeof v === 'string' && !text && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v); // Sheets coercion
          if (typeof v === 'string' && !text && /^(true|false)$/i.test(v)) v = v.toLowerCase() === 'true';
          if (typeof v === 'boolean' && text) v = v ? 'TRUE' : 'FALSE';
          if (typeof v === 'number' && text) v = String(v);
          this.s.rows[ri][col - 1] = v;
        }
      }
      return this;
    }
    setValue(v) { return this.setValues([[v]]); }
    clearContent() {
      for (let i = 0; i < this.nr; i++) {
        const row = this.s.rows[this.r - 1 + i];
        if (row) for (let j = 0; j < this.nc; j++) row[this.c - 1 + j] = '';
      }
      return this;
    }
    setNumberFormat(f) {
      if (f === '@' && this.r >= 2) for (let j = 0; j < this.nc; j++) this.s.textCols[this.c + j] = true;
      return this;
    }
    setFontWeight() { return this; }
  }

  class Spreadsheet {
    constructor() { this.sheets = [new Sheet('Sheet1')]; this.id = 'SS_LOCAL'; }
    getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
    insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
    getSheets() { return this.sheets.slice(); }
    deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
    getUrl() { return 'https://docs.google.com/spreadsheets/d/SS_LOCAL/edit'; }
    getId() { return this.id; }
  }

  function readHtml(name) {
    for (const dir of htmlDirs) {
      const p = path.join(dir, name + '.html');
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    }
    throw new Error('No HTML file named ' + name + ' was found.');
  }

  let theSS = null;
  const ctx = {
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in cache ? cache[k] : null),
        put: (k, v) => { cache[k] = v; },
        remove: (k) => { delete cache[k]; },
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: {
      create: () => (theSS = new Spreadsheet()),
      openById: (id) => { if (!theSS || id !== theSS.id) throw new Error('not found'); return theSS; },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(s).digest()).map((b) => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      newBlob: (s) => ({ getBytes: () => Array.from(Buffer.from(s, 'utf8')) }),
      base64Encode: (b) => Buffer.from(b).toString('base64'),
    },
    HtmlService: {
      createHtmlOutputFromFile: (name) => { const c = readHtml(name); return { getContent: () => c }; },
    },
  };
  vm.createContext(ctx);
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.gs')).sort();
  if (!files.length) {
    throw new Error('gas-runtime: no .gs files in ' + srcDir + '. The backend lives in ' + GS_DIR + ' (GS_DIR) since v3.');
  }
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(srcDir, f), 'utf8'), ctx, { filename: f });
  for (const dir of (opts && opts.gsDirs) || []) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.gs')).sort()) {
      vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: path.join(dir, f) });
    }
  }
  if (extraCode) vm.runInContext(extraCode, ctx, { filename: 'extra.js' });

  /** Calls a server function the way google.script.run does: public names only, JSON-shaped result. */
  function run(fnName, args) {
    if (typeof fnName !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(fnName) || typeof ctx[fnName] !== 'function') {
      throw new Error('Script function not found: ' + fnName);
    }
    const result = ctx[fnName].apply(null, args || []);
    return result === undefined ? null : JSON.parse(JSON.stringify(result));
  }

  return { ctx, props, cache, ss: () => theSS, files, run };
}

module.exports = { makeRuntime, CELL_LIMIT, GS_DIR };
