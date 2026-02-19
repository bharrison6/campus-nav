/**
 * Code.gs — Main router for Murray State Campus Navigation
 * Routes doGet/doPost requests by ?action= parameter.
 */

function doGet(e) {
  var params = e ? (e.parameter || {}) : {};
  var action = params.action || '';

  // Admin page
  if (action === 'admin') {
    return HtmlService.createHtmlOutputFromFile('Admin')
      .setTitle('Campus Nav Admin')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // Serve the web app (default when no action specified)
  if (!action || action === 'web') {
    return HtmlService.createHtmlOutputFromFile('WebApp')
      .setTitle('Murray State Campus Nav')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // API routes
  try {
    var data = routeAction(action, params);
    return jsonResponse({ ok: true, data: data });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var data = routeAction(body.action, body);
    return jsonResponse({ ok: true, data: data });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

function routeAction(action, params) {
  switch (action) {
    case 'ping':
      return 'pong';
    case 'init':
      return initSystem();
    case 'getAllCampusData':
      return getAllCampusData();
    case 'getDataVersion':
      return getDataVersion();
    default:
      throw new Error('Unknown action: ' + action);
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
