/*
 * Merges consecutive stops that landed in the SAME Geotab zone into one.
 *
 * A vehicle shuffling around inside its own yard (or a large client lot)
 * often crosses the stop-speed threshold briefly between what is really
 * one continuous visit — without this, that shows up as several short
 * stops back-to-back instead of one. Only merges when both stops matched
 * a zone (never merges plain-address or coordinate-only stops, since those
 * aren't a reliable enough "same place" signal).
 *
 * Expects `stops` sorted chronologically ASCENDING, each with Date objects
 * for start/end (not yet formatted for display).
 */

function mergeConsecutiveZoneStops(stops) {
  if (!stops.length) return stops;

  const merged = [];
  let current = { ...stops[0] };

  for (let i = 1; i < stops.length; i++) {
    const next = stops[i];
    const sameZone = current.zoneName && next.zoneName && current.zoneName === next.zoneName;

    if (sameZone) {
      current.end = next.end;
      current.ongoing = next.ongoing;
      current.durationSeconds = Math.round((current.end - current.start) / 1000);
      // Keep the location of the most recent segment
      current.lat = next.lat;
      current.lng = next.lng;
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);

  return merged;
}

module.exports = { mergeConsecutiveZoneStops };
