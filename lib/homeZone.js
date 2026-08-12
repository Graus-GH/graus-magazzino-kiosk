const HOME_ZONE_MATCH = "graus";

function isHomeZone(zoneName) {
  return !!(zoneName && zoneName.toLowerCase().includes(HOME_ZONE_MATCH));
}

module.exports = { isHomeZone, HOME_ZONE_MATCH };
