/*
 * GRAUS Fleet Kiosk — /api/performance
 *
 * Returns all three time ranges (week/month/year) in one response instead
 * of one at a time — the TV page needs to switch between them instantly
 * (manually or via auto-rotation) without a network round-trip in between,
 * so everything is precomputed here and the client just swaps which one it
 * renders.
 *   - week:  last 7 days,        daily buckets
 *   - month: current month,      weekly buckets, Monday-Sunday (GRAUS's own
 *            week start), labeled by the day-of-month range that actually
 *            falls in this month, e.g. "1–7" or just "1" for a short first
 *            week
 *   - year:  rolling 12 months,  monthly buckets
 *
 * Trip data is fetched ONCE for the widest (365-day) window — week's and
 * month's windows are both subsets of it — then filtered in memory per
 * range, rather than querying Geotab three times for heavily overlapping
 * data.
 */

const { geotabCall } = require("../lib/geotabClient");
const { startOfDayRome, startOfMonthRome, dateKeyRome, startOfDateStringRome, addDaysRome, startOfWeekRome } = require("../lib/timezone");
const { parseDurationSeconds } = require("../lib/duration");
const { cleanName } = require("../lib/cleanName");
const { isRevealRequested, buildDriverNameMap } = require("../lib/driverReveal");

const TRIP_RESULTS_LIMIT = 50000;
const RANGE_KEYS = ["week", "month", "year"];

function romeMonthLabel(date) {
  return new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", month: "short" }).format(date);
}

function rangeFromFor(range, now) {
  if (range === "year") return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  if (range === "month") return startOfMonthRome(now);
  return new Date(startOfDayRome(now).getTime() - 6 * 24 * 60 * 60 * 1000); // week
}

function domNumber(dateAtRomeMidnight, monthStart) {
  return Math.round((dateAtRomeMidnight - monthStart) / 86400000) + 1;
}

// Label for the days of `weekStart`'s Mon-Sun week that actually fall
// within this month and have already elapsed — a plain day-of-month range
// (e.g. "1–7") reads unambiguously, unlike a "week number" that looks like
// it might mean something calendar-wide (ISO week, etc.) when it doesn't.
// elapsedDays doubles as "today's day-of-month number" here, since
// monthStart is always the 1st.
function monthWeekLabel(weekStart, monthStart, elapsedDays) {
  const weekEnd = addDaysRome(weekStart, 6);
  const displayStart = weekStart < monthStart ? monthStart : weekStart;
  const startDay = domNumber(displayStart, monthStart);
  const endDay = Math.min(domNumber(weekEnd, monthStart), elapsedDays);
  return startDay === endDay ? String(startDay) : `${startDay}–${endDay}`;
}

function bucketKeyAndLabel(range, tripStart, rangeFrom, elapsedDays) {
  if (range === "year") {
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit" }).format(tripStart);
    return { key, label: romeMonthLabel(tripStart) };
  }
  if (range === "month") {
    // GRAUS's week starts Monday — bucket by the real Mon-Sun calendar
    // week the trip falls in, not by "days since the 1st of the month"
    // (which drifts off actual weeks whenever the month doesn't start on
    // a Monday).
    const weekStart = startOfWeekRome(tripStart);
    return { key: dateKeyRome(weekStart), label: monthWeekLabel(weekStart, rangeFrom, elapsedDays) };
  }
  // week: one bucket per calendar day
  const key = dateKeyRome(tripStart);
  const label = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", weekday: "short" }).format(tripStart);
  return { key, label };
}

function fallbackLabel(range, key, rangeFrom, elapsedDays) {
  if (range === "week") {
    const d = new Date(key + "T12:00:00");
    return new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", weekday: "short" }).format(d);
  }
  if (range === "month") return monthWeekLabel(startOfDateStringRome(key), rangeFrom, elapsedDays);
  const d = new Date(key + "-01T12:00:00");
  return romeMonthLabel(d);
}

// Builds the full { totals, chart, kmPerVehicle, idling } payload for one
// range, given trips already filtered down to that range's window (see the
// single wide fetch in the handler below).
function buildRangeResult(range, rangeFrom, elapsedDays, now, trips, devices, revealDrivers, driverNameByDeviceId) {
  let totalKm = 0;
  let totalDrivingSeconds = 0;
  let totalIdlingSeconds = 0;
  const buckets = {}; // key -> { label, km }
  const kmByDevice = {};
  const idlingByDevice = {};

  trips.forEach(t => {
    const start = new Date(t.start);
    const dist = t.distance || 0;
    const drivingSec = parseDurationSeconds(t.drivingDuration);
    const idlingSec = parseDurationSeconds(t.idlingDuration);

    totalKm += dist;
    totalDrivingSeconds += drivingSec;
    totalIdlingSeconds += idlingSec;

    const { key, label } = bucketKeyAndLabel(range, start, rangeFrom, elapsedDays);
    if (!buckets[key]) buckets[key] = { key, label, km: 0 };
    buckets[key].km += dist;

    const id = t.device.id;
    kmByDevice[id] = (kmByDevice[id] || 0) + dist;
    idlingByDevice[id] = (idlingByDevice[id] || 0) + idlingSec;
  });

  // Ensure every expected bucket exists even with zero trips, in order
  const bucketOrder = [];
  if (range === "week") {
    const startOfToday = startOfDayRome(now);
    for (let i = 6; i >= 0; i--) {
      const d = new Date(startOfToday.getTime() - i * 86400000);
      bucketOrder.push(bucketKeyAndLabel(range, d, rangeFrom, elapsedDays).key);
    }
  } else if (range === "month") {
    let weekStart = startOfWeekRome(rangeFrom);
    const lastWeekStart = startOfWeekRome(now);
    while (weekStart <= lastWeekStart) {
      bucketOrder.push(dateKeyRome(weekStart));
      weekStart = addDaysRome(weekStart, 7);
    }
  } else {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      bucketOrder.push(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit" }).format(d));
    }
  }
  const chart = bucketOrder.map(key => buckets[key]
    ? { label: buckets[key].label, km: Math.round(buckets[key].km * 10) / 10 }
    : { label: fallbackLabel(range, key, rangeFrom, elapsedDays), km: 0 });

  const kmPerVehicle = devices
    .map(d => ({
      name: cleanName(d.name),
      driverName: revealDrivers ? (driverNameByDeviceId[d.id] || null) : undefined,
      km: Math.round((kmByDevice[d.id] || 0) * 10) / 10
    }))
    .sort((a, b) => b.km - a.km);

  const idling = devices
    .map(d => ({
      name: cleanName(d.name),
      driverName: revealDrivers ? (driverNameByDeviceId[d.id] || null) : undefined,
      idlingSeconds: Math.round(idlingByDevice[d.id] || 0)
    }))
    .sort((a, b) => a.idlingSeconds - b.idlingSeconds);

  return {
    totals: {
      km: Math.round(totalKm),
      drivingHoursSeconds: Math.round(totalDrivingSeconds),
      idlingHoursSeconds: Math.round(totalIdlingSeconds),
      avgKmPerDay: elapsedDays > 0 ? Math.round((totalKm / elapsedDays) * 10) / 10 : 0
    },
    chart,
    kmPerVehicle,
    idling
  };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    const now = new Date();
    const widestFrom = rangeFromFor("year", now); // 365 days back — a superset of week's and month's windows

    const [devices, trips] = await Promise.all([
      geotabCall("Get", { typeName: "Device", search: { fromDate: now.toISOString() } }),
      geotabCall("Get", {
        typeName: "Trip",
        search: { fromDate: widestFrom.toISOString() },
        resultsLimit: TRIP_RESULTS_LIMIT
      })
    ]);

    const revealDrivers = isRevealRequested(req);
    const driverNameByDeviceId = revealDrivers ? await buildDriverNameMap(trips) : {};

    const ranges = {};
    RANGE_KEYS.forEach(range => {
      const rangeFrom = rangeFromFor(range, now);
      const elapsedDays = range === "year" ? 365
        : range === "month" ? Math.round((now - rangeFrom) / 86400000) + 1
        : 7;

      const scopedTrips = trips.filter(t => new Date(t.start) >= rangeFrom);

      ranges[range] = buildRangeResult(range, rangeFrom, elapsedDays, now, scopedTrips, devices, revealDrivers, driverNameByDeviceId);
    });

    res.status(200).json({
      generatedAt: now.toISOString(),
      ranges
    });
  } catch (err) {
    console.error("GRAUS Fleet Kiosk performance API error:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
