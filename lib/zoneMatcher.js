/*
 * Matches a coordinate against Geotab Zones (the client areas GRAUS has
 * already drawn on the map in MyGeotab), so a stop can be labeled with a
 * zone name instead of just raw coordinates.
 *
 * NOTE: only polygon zones (3+ points) are matched reliably with the
 * ray-casting test below. Purely circular/point zones in Geotab aren't
 * handled yet — if client zones are drawn as circles rather than polygons,
 * matching may miss them. Worth revisiting once we see how your zones are
 * actually shaped in practice.
 */

const { geotabCall } = require("./geotabClient");

const CACHE_TTL_MS = 10 * 60 * 1000; // zones rarely change — cache 10 min
let cache = { zones: null, fetchedAt: 0 };

async function getZones() {
  const now = Date.now();
  if (cache.zones && (now - cache.fetchedAt) < CACHE_TTL_MS) {
    return cache.zones;
  }

  const raw = await geotabCall("Get", { typeName: "Zone", search: {} });

  const zones = raw
    .filter(z => Array.isArray(z.points) && z.points.length >= 3)
    .map(z => ({
      id: z.id,
      name: z.name,
      // Geotab Zone points use x = longitude, y = latitude
      points: z.points.map(p => ({ lat: p.y, lng: p.x }))
    }));

  cache = { zones, fetchedAt: now };
  return zones;
}

// Standard ray-casting point-in-polygon test
function pointInPolygon(lat, lng, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].lng, yi = points[i].lat;
    const xj = points[j].lng, yj = points[j].lat;
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

async function matchZone(lat, lng) {
  const zones = await getZones();
  for (const zone of zones) {
    if (pointInPolygon(lat, lng, zone.points)) {
      return zone.name;
    }
  }
  return null;
}

module.exports = { matchZone, getZones };
