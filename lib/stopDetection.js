/*
 * Stop detection from raw LogRecord (GPS ping) data.
 *
 * Geotab's Trip.stopDuration only reflects gaps BETWEEN Trips, and Trips are
 * segmented by Geotab's own rules (often tied to ignition on/off) — a stop
 * with the engine left running may not create a Trip boundary at all, and
 * so would be invisible to a Trip-based calculation. Working from raw
 * LogRecord points instead measures actual physical stops directly.
 *
 * records: array of { dateTime, latitude, longitude, speed }, ANY order.
 * Returns: array of stop segments, chronological, each:
 *   { start: Date, end: Date, durationSeconds, lat, lng, ongoing: boolean }
 */

function computeStops(records, { stopSpeedKmh = 3, minStopSeconds = 120, now = new Date() } = {}) {
  const points = records
    .filter(r => r.latitude != null && r.longitude != null)
    .map(r => ({
      time: new Date(r.dateTime),
      lat: r.latitude,
      lng: r.longitude,
      speed: r.speed || 0
    }))
    .sort((a, b) => a.time - b.time);

  const stops = [];
  let current = null; // { startIdx, points: [] }

  for (const p of points) {
    const isStopped = p.speed <= stopSpeedKmh;

    if (isStopped) {
      if (!current) current = { points: [] };
      current.points.push(p);
    } else {
      if (current) {
        stops.push(finalizeStop(current, false));
        current = null;
      }
    }
  }

  // Vehicle still stopped at the last known point — ongoing stop, ends "now"
  if (current) {
    stops.push(finalizeStop(current, true, now));
  }

  return stops.filter(s => s.durationSeconds >= minStopSeconds);
}

function finalizeStop(segment, ongoing, now) {
  const pts = segment.points;
  const start = pts[0].time;
  const end = ongoing ? now : pts[pts.length - 1].time;
  const avgLat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const avgLng = pts.reduce((s, p) => s + p.lng, 0) / pts.length;

  return {
    start,
    end,
    durationSeconds: Math.round((end - start) / 1000),
    lat: avgLat,
    lng: avgLng,
    ongoing
  };
}

module.exports = { computeStops };
