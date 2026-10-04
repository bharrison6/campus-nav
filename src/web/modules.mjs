// Loads the page's ES modules for the classic (ES5) app scripts: MapLibre GL JS, vendored by the build into vendor/
// (no CDN; the service worker precaches it), and the georef transform shared with the exporter (src/shared/georef.mjs,
// copied to vendor/georef.mjs; optional: without it the map has no indoor building view). Published as
// vendor/modules.mjs; WebApp.html loads it with <script type="module">, so browsers without modules skip it and the
// Map tab falls back to the building list.
//   window.MSCNModules = {maplibregl, georef}   then the 'mscn-modules' event on window
import * as maplibregl from './maplibre-gl.mjs';

let georef = null;
try {
  georef = await import('./georef.mjs');
} catch (e) {
  georef = null;
}
window.MSCNModules = { maplibregl, georef };
window.dispatchEvent(new Event('mscn-modules'));
