/*
 * Geotab returns duration fields (Trip.idlingDuration, stopDuration,
 * drivingDuration) as formatted duration STRINGS in some API responses —
 * e.g. ".NET TimeSpan" style "00:12:34" or ISO 8601 "PT12M34S" — not as a
 * plain number of seconds. Treating them as numbers directly produces NaN
 * (which then silently becomes `null` once serialized to JSON).
 *
 * This normalizes any of those shapes into a plain number of seconds.
 */

function parseDurationSeconds(value) {
  if (value == null) return 0;
  if (typeof value === "number") return isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;

  // ISO 8601 duration: P[nD]T[nH][nM][nS]
  const iso = value.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/);
  if (iso && (iso[1] || iso[2] || iso[3] || iso[4])) {
    const days = parseFloat(iso[1] || 0);
    const hours = parseFloat(iso[2] || 0);
    const minutes = parseFloat(iso[3] || 0);
    const seconds = parseFloat(iso[4] || 0);
    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
  }

  // .NET TimeSpan: [d.]hh:mm:ss[.fffffff]
  const ts = value.match(/^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (ts) {
    const days = parseFloat(ts[1] || 0);
    const hours = parseFloat(ts[2]);
    const minutes = parseFloat(ts[3]);
    const seconds = parseFloat(ts[4]);
    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
  }

  const asNumber = parseFloat(value);
  return isFinite(asNumber) ? asNumber : 0;
}

module.exports = { parseDurationSeconds };
