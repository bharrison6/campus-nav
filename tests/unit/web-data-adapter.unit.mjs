// The static site's data adapter (src/web/WebApp_Data.html) and analytics helpers (WebApp_Analytics.html):
// the cache decision, version keys, relative URLs, config normalization, query parsing, event shaping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInclude } from './load-include.mjs';

const D = loadInclude('WebApp_Data.html', 'MSCNData');
const A = loadInclude('WebApp_Analytics.html', 'MSCNAnalytics');
const plain = (v) => JSON.parse(JSON.stringify(v));

test('planLoad: current cache is used, a newer version or no cache fetches, a failed check falls back to the cache', () => {
  const cached = { data: { buildings: [] }, version: 'abc' };
  assert.equal(D.planLoad(cached, 'abc', false), 'cache');
  assert.equal(D.planLoad(cached, 'def', false), 'fetch');
  assert.equal(D.planLoad(null, 'abc', false), 'fetch');
  assert.equal(D.planLoad(cached, null, true), 'stale');
  assert.equal(D.planLoad(cached, undefined, false), 'stale'); // version.json without a version reads as unknown
  assert.equal(D.planLoad(null, null, true), 'fetch'); // first visit while version.json fails: still try campus.json
  assert.equal(D.planLoad({ data: null, version: 'abc' }, 'abc', false), 'fetch');
  assert.equal(D.planLoad({ data: {}, version: 7 }, '7', false), 'cache'); // versions compare as text
});

test('versionOf: a payload is cached under its own version (campus.version, then Config.dataVersion), never the advertised one', () => {
  assert.equal(D.versionOf('v9', { version: 'x' }), 'x', 'an old payload is never relabelled with a new version');
  assert.equal(D.versionOf(null, { version: 3 }), '3');
  assert.equal(D.versionOf('', { config: [{ key: 'dataVersion', value: 12 }] }), '12');
  assert.equal(D.versionOf('v9', { config: [{ key: 'dataVersion', value: 12 }] }), '12');
  assert.equal(D.versionOf('v9', {}), 'v9', 'a payload that names no version takes the advertised one');
  assert.equal(D.versionOf(null, {}), '0');
});

test('isVersion: a payload is accepted only as the version that was advertised', () => {
  assert.equal(D.isVersion('new', { version: 'new' }), true);
  assert.equal(D.isVersion('new', { version: 'old' }), false);
  assert.equal(D.isVersion('7', { version: 7 }), true, 'versions compare as text');
  assert.equal(D.isVersion('new', { config: [{ key: 'dataVersion', value: 'old' }] }), false);
  assert.equal(D.isVersion(null, { version: 'old' }), true, 'nothing advertised: nothing to disagree with');
  assert.equal(D.isVersion('new', {}), true, 'a payload with no version cannot disagree');
});

test('every data URL is relative to the page (no leading slash) and versioned where cached', () => {
  const all = [D.urls.config(), D.urls.version(), D.urls.campus('v1'), D.urls.floor('floor-it-1', 'v1'), D.urls.schedule('eday'), D.urls.links()];
  assert.deepEqual(all, ['config.json', 'data/version.json', 'data/campus.json?v=v1', 'floors/floor-it-1.svg?v=v1', 'data/schedules/eday.json', 'data/links.json']);
  for (const u of all) assert.ok(!u.startsWith('/') && !/^[a-z]+:/i.test(u), u);
  assert.equal(D.urls.campus(''), 'data/campus.json');
  assert.equal(D.urls.floor('a b', null), 'floors/a%20b.svg');
});

test('ids: letters, digits, hyphen and underscore only', () => {
  for (const ok of ['floor-it-1', 'eday_2026', 'A1']) assert.equal(D.isId(ok), true, ok);
  for (const bad of ['', '../x', 'a/b', 'a b', 'x'.repeat(81), null, 5]) assert.equal(D.isId(bad), false, String(bad));
});

test('normalizeConfig: defaults, junk reads as not configured, and a stale mapsApiKey is dropped (v4 has no map key)', () => {
  assert.deepEqual(plain(D.normalizeConfig(null)), { analytics: { provider: 'goatcounter', site: '' }, basePath: '', domain: '' });
  assert.deepEqual(plain(D.normalizeConfig({ mapsApiKey: 'k', analytics: { provider: 'goatcounter', site: 'msu' }, basePath: '/campus-nav/' })),
    { analytics: { provider: 'goatcounter', site: 'msu' }, basePath: '/campus-nav/', domain: '' });
  assert.equal(D.normalizeConfig({ analytics: 'x' }).analytics.site, '');
});

test('the map manifest is a relative URL under data/', () => {
  assert.equal(D.urls.mapManifest(), 'data/map-manifest.json');
});

test('queryParams keeps ?qr= raw (base64) and decodes the rest; pageUrl drops query and hash', () => {
  const p = plain(D.queryParams('?qr=eyJ0eXBlIjoi%2BbG9j+YQ==&room=room-it-1-0141&nav=1&sched=eday%2Dsample&loc&x=%E0%A4'));
  assert.equal(p.qr, 'eyJ0eXBlIjoi%2BbG9j+YQ==');
  assert.equal(p.room, 'room-it-1-0141');
  assert.equal(p.nav, '1');
  assert.equal(p.sched, 'eday-sample');
  assert.equal(p.loc, '');
  assert.equal('x' in p, false, 'a malformed escape is skipped, not thrown');
  assert.deepEqual(plain(D.queryParams('')), {});
  assert.equal(D.pageUrl({ href: 'https://h.example/campus-nav/?room=1#x' }), 'https://h.example/campus-nav/');
  assert.equal(D.pageUrl({ href: 'https://h.example/campus-nav/index.html' }), 'https://h.example/campus-nav/index.html');
});

test('payload sniffers', () => {
  assert.equal(D.looksLikeCampus({ buildings: [] }), true);
  assert.equal(D.looksLikeCampus('<html>'), false);
  assert.equal(D.looksLikeSvg('<?xml?><svg/>'), true);
  assert.equal(D.looksLikeSvg('<!DOCTYPE html><title>404</title>'), false); // a Pages 404 body is not a plan
});

test('analytics: endpoint from a site code or a full https URL; anything else stays off', () => {
  assert.equal(A.endpointFor('msu-campus-nav'), 'https://msu-campus-nav.goatcounter.com/count');
  assert.equal(A.endpointFor('MSU'), 'https://msu.goatcounter.com/count');
  assert.equal(A.endpointFor('https://stats.example.org/count'), 'https://stats.example.org/count');
  for (const off of ['', '  ', 'http://x.example/count', 'bad site', '"><script>', null]) assert.equal(A.endpointFor(off), '', String(off));
});

test('analytics: only the six named events, with a short non-personal label', () => {
  assert.deepEqual(plain(A.EVENTS), ['search', 'route_start', 'route_from', 'route_reroute', 'floor_change', 'qr_scan', 'sched_open']);
  assert.deepEqual(plain(A.eventFor('floor_change', 'floor-it-2')), { path: 'floor_change', title: 'floor-it-2', event: true });
  assert.deepEqual(plain(A.eventFor('search')), { path: 'search', title: 'search', event: true });
  assert.equal(A.eventFor('page_scroll', 'x'), null);
  assert.equal(A.eventFor('search', '<b>' + 'y'.repeat(100)).title.length, 60);
  assert.equal(/[<>]/.test(A.eventFor('search', '<b>').title), false);
  // before config.json is read, events wait in a bounded queue; a config without a site drops them for good
  A.track('search', 'room');
  A.track('not_an_event');
  assert.equal(A.state.queue.length, 1);
  assert.equal(A.init({ provider: 'goatcounter', site: '' }), false);
  assert.equal(A.state.queue.length, 0);
  A.track('search', 'room');
  assert.equal(A.state.queue.length, 0);
});
