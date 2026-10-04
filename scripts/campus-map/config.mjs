// Campus-map configuration: where the data comes from and where it goes.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const OUT_DIR = path.join(REPO, 'data', 'campus-map');
export const GEOREF_DIR = path.join(REPO, 'data', 'georef');
export const FLOORPLANS_DIR = path.join(REPO, 'data', 'floorplans');
export const OVERRIDES_DIR = path.join(REPO, 'data', 'overrides');
/** Raw downloads (OSM JSON). Gitignored: only the derived, compact layers are committed. */
export const CACHE_DIR = path.join(HERE, '.cache');

/**
 * The download box: the envelope of the 89 seeded buildings (SeedData.gs) plus about 150 m, rounded outward.
 * The plan's box (lat 36.606..36.625, lng -88.333..-88.310) misses the Expo Center and Carman Pavilion to the west.
 */
export const BBOX = { minLat: 36.6065, minLng: -88.3425, maxLat: 36.6250, maxLng: -88.3135 };

/** Campus center: the origin of the local metric frame used for fitting (equirectangular, accurate to cm here). */
export const CENTER = { lat: 36.6155, lng: -88.3220 };

export const OSM_API = ['https://api.openstreetmap.org/api/0.6/map.json'];
export const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export const USER_AGENT = 'MurrayStateCampusNavigation/4 (campus-map data build; github.com/bharrison6/campus-nav)';

export const ATTRIBUTION = {
  osm: '© OpenStreetMap contributors (ODbL 1.0, https://www.openstreetmap.org/copyright)',
  naip: 'USDA NAIP, public domain',
};
