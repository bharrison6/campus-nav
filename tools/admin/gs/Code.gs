/**
 * Code.gs — Router and floor-plan reader for Murray State Campus Navigation.
 * getFloorPlanSvg feeds the export (floors/<id>.svg) and the admin canvases.
 * doGet/doPost are the v2 Apps Script entry points: nothing deploys them since
 * v3; they remain only while the v2 dev harness (dev/serve.mjs) still calls them.
 */

/*
 * HtmlService ignores a viewport <meta> inside the page, so each page's viewport
 * is set here. The web app draws under the notch and pads with
 * env(safe-area-inset-*), which needs viewport-fit=cover; the admin page does not.
 */
var PAGES_ = {
  web: { file: 'WebApp', title: 'Murray State Campus Nav',
    viewport: 'width=device-width, initial-scale=1, viewport-fit=cover' },
  admin: { file: 'Admin', title: 'Campus Nav Admin',
    viewport: 'width=device-width, initial-scale=1' }
};

function doGet(e) {
  var params = e ? (e.parameter || {}) : {};
  var action = params.action || '';

  if (!action || action === 'web') return servePage_(PAGES_.web);
  if (action === 'admin') return servePage_(PAGES_.admin);

  try {
    return jsonResponse_({ ok: true, data: routeAction_(action, params) });
  } catch (err) {
    return jsonResponse_({ ok: false, error: err.message });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    return jsonResponse_({ ok: true, data: routeAction_(body.action, body) });
  } catch (err) {
    return jsonResponse_({ ok: false, error: err.message });
  }
}

function servePage_(page) {
  return HtmlService.createTemplateFromFile(page.file)
    .evaluate()
    .setTitle(page.title)
    .addMetaTag('viewport', page.viewport)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Template helper: <?!= include('WebApp_styles') ?> inlines another project
 * HTML file's content.
 * @param {string} name - Project HTML file name without extension.
 * @return {string}
 */
function include(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error('include: invalid file name');
  }
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * Returns a floor's SVG floor plan (the raw <svg> string) from the embedded
 * project file FP_<floorId with hyphens as underscores>, for example
 * floor-it-1 -> FP_floor_it_1. Callable through google.script.run and as
 * ?action=getFloorPlanSvg&floorId=floor-it-1.
 * @param {string} floorId
 * @return {string}
 */
function getFloorPlanSvg(floorId) {
  if (typeof floorId !== 'string' || !/^[A-Za-z0-9-]+$/.test(floorId)) {
    throw new Error('getFloorPlanSvg: floorId is required (letters, digits, hyphens)');
  }
  var asset = 'FP_' + floorId.replace(/-/g, '_');
  var content;
  try {
    content = HtmlService.createHtmlOutputFromFile(asset).getContent();
  } catch (e) {
    throw new Error('Floor plan asset ' + asset + ' not found for floor ' + floorId);
  }
  if (!content || content.indexOf('<svg') === -1) {
    throw new Error('Floor plan asset ' + asset + ' holds no <svg> for floor ' + floorId);
  }
  return content;
}

function routeAction_(action, params) {
  switch (action) {
    case 'ping':
      return 'pong';
    case 'init':
      return initSystem();
    case 'getAllCampusData':
      return getAllCampusData();
    case 'getPublicCampusData':
      return getPublicCampusData();
    case 'getCampusDataStats':
      return getCampusDataStats();
    case 'getDataVersion':
      return getDataVersion();
    case 'getFloorPlanSvg':
      return getFloorPlanSvg(params.floorId);
    default:
      throw new Error('Unknown action: ' + action);
  }
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
