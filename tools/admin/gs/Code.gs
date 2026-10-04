/**
 * Code.gs — floor-plan reader for Murray State Campus Navigation.
 * getFloorPlanSvg feeds the build-time export (floors/<id>.svg) and the admin
 * canvases. The v2 web entry points (doGet/doPost, page templates, JSON
 * actions) were removed in v3: the app is a static site and these files run
 * only in the Node stand-in (dev/gas-runtime.cjs).
 */

/**
 * Returns a floor's SVG floor plan (the raw <svg> string) from the embedded
 * project file FP_<floorId with hyphens as underscores>, for example
 * floor-it-1 -> FP_floor_it_1. Callable through google.script.run (the local
 * admin) and by the export.
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
