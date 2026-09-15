/*
 * GRAUS Fleet Kiosk — /api/performance
 *
 * Returns all three time ranges (week/month/year) in one response instead
 * of one at a time — the TV page needs to switch between them instantly
 * (manually or via auto-rotation) without a network round-trip in between,
 * so everything is precomputed here and the client just swaps which one it
 * renders.
 *   - week:  last 7 days,        daily buckets
 *   - month: current month,      weekly buckets (labeled by day-of-month range, e.g. "1–7")
 *   - year:  rolling 12 months,  monthly buckets
 *
 * Trip and ExceptionEvent data is fetched ONCE for the widest (365-day)
 * window — week's and month's windows are both subsets of it — then
 * filtered in memory per range, rather than querying Geotab three times
 * for heavily overlapping data.
 */

const { geotabCall } = require("../lib/geotabClient");
const { startOfDayRome, startOfMonthRome, dateKeyRome } = require("../lib/timezone");
const { parseDurationSeconds } = require("../lib/duration");
const { cleanName } = require("../lib/cleanName");
const { isRevealRequested, buildDriverNameMap } = require("../lib/driverReveal");
const { getSpeedingRuleId, SPEEDING_RULE_NAME } = require("../lib/speedingRule");

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

// "Sett. 1 / Sett. 2" (week-of-month index) reads as if it means something
// calendar-wise (ISO week number, etc.) when it's really just "days
// 1-7 of this month" — a plain day-of-month range is unambiguous instead.
// elapsedDays clamps the last, still-in-progress week so it can't claim
// days that haven't happened yet (or don't exist, e.g. "29-35" in Feb).
function monthWeekLabel(weekIndex, elapsedDays) {
  const startDay = (weekIndex - 1) * 7 + 1;
  const endDay = Math.min(weekIndex * 7, elapsedDays);
  return startDay === endDay ? String(startDay) : `${startDay}–${endDay}`;
}

function bucketKeyAndLabel(range, tripStart, rangeFrom, elapsedDays) {
  if (range === "year") {
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit" }).format(tripStart);
    return { key, label: romeMonthLabel(tripStart) };
  }
  if (range === "month") {
    const dayOfRange = Math.floor((tripStart - rangeFrom) / 86400000);
    const weekIndex = Math.floor(dayOfRange / 7) + 1;
    const key = "w" + weekIndex;
    return { key, label: monthWeekLabel(weekIndex, elapsedDays) };
  }
  // week: one bucket per calendar day
  const key = dateKeyRome(tripStart);
  const label = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", weekday: "short" }).format(tripStart);
  return { key, label };
}

function fallbackLabel(range, key, elapsedDays) {
  if (range === "week") {
    const d = new Date(key + "T12:00:00");
    return new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", weekday: "short" }).format(d);
  }
  if (range === "month") return monthWeekLabel(parseInt(key.replace("w", ""), 10), elapsedDays);
  const d = new Date(key + "-01T12:00:00");
  return romeMonthLabel(d);
}

// Builds the full { totals, chart, kmPerVehicle, idling, speeding } payload
// for one range, given trips/events already filtered down to that range's
// window (see the single wide fetch in the handler below).
function buildRangeResult(range, rangeFrom, elapsedDays, now, trips, events, devices, revealDrivers, driverNameByDeviceId, speedingAvailable) {
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
    const totalWeeks = Math.ceil(elapsedDays / 7);
    for (let i = 1; i <= totalWeeks; i++) bucketOrder.push("w" + i);
  } else {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      bucketOrder.push(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit" }).format(d));
    }
  }
  const chart = bucketOrder.map(key => buckets[key]
    ? { label: buckets[key].label, km: Math.round(buckets[key].km * 10) / 10 }
    : { label: fallbackLabel(range, key, elapsedDays), km: 0 });

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

  // Speeding: Geotab's own "Eccesso di velocità (nuova versione)" rule,
  // which compares actual speed against the posted road speed limit —
  // triggers at 20%+ over the limit for 5+ seconds. Events are pre-filtered
  // to this range's window by the caller.
  const byDevice = {};
  events.forEach(e => {
    const id = e.device && e.device.id;
    if (!id) return;
    if (!byDevice[id]) byDevice[id] = { eventCount: 0, totalDurationSeconds: 0 };
    byDevice[id].eventCount += 1;
    const durSec = (new Date(e.activeTo) - new Date(e.activeFrom)) / 1000;
    if (isFinite(durSec) && durSec > 0) byDevice[id].totalDurationSeconds += durSec;
  });
  const speeding = devices
    .map(d => ({
      name: cleanName(d.name),
      driverName: revealDrivers ? (driverNameByDeviceId[d.id] || null) : undefined,
      eventCount: (byDevice[d.id] || {}).eventCount || 0,
      totalDurationSeconds: Math.round((byDevice[d.id] || {}).totalDurationSeconds || 0)
    }))
    .sort((a, b) => b.eventCount - a.eventCount);

  return {
    totals: {
      km: Math.round(totalKm),
      drivingHoursSeconds: Math.round(totalDrivingSeconds),
      idlingHoursSeconds: Math.round(totalIdlingSeconds),
      avgKmPerDay: elapsedDays > 0 ? Math.round((totalKm / elapsedDays) * 10) / 10 : 0
    },
    chart,
    kmPerVehicle,
    idling,
    speeding,
    speedingAvailable
  };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    const now = new Date();
    const startOfToday = startOfDayRome(now);
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

    let allEvents = [];
    let speedingAvailable = false;
    try {
      const ruleId = await getSpeedingRuleId();
      if (ruleId) {
        speedingAvailable = true;
        allEvents = await geotabCall("Get", {
          typeName: "ExceptionEvent",
          search: {
            ruleSearch: { id: ruleId },
            fromDate: widestFrom.toISOString(),
            toDate: now.toISOString()
          }
        });
      } else {
        console.error("Speeding rule not found by name:", SPEEDING_RULE_NAME);
      }
    } catch (err) {
      console.error("Speeding via ExceptionEvent failed:", err.message);
    }

    const ranges = {};
    RANGE_KEYS.forEach(range => {
      const rangeFrom = rangeFromFor(range, now);
      const elapsedDays = range === "year" ? 365
        : range === "month" ? Math.round((now - rangeFrom) / 86400000) + 1
        : 7;

      const scopedTrips = trips.filter(t => new Date(t.start) >= rangeFrom);
      const scopedEvents = allEvents.filter(e => new Date(e.activeFrom) >= rangeFrom);

      ranges[range] = buildRangeResult(
        range, rangeFrom, elapsedDays, now,
        scopedTrips, scopedEvents, devices,
        revealDrivers, driverNameByDeviceId, speedingAvailable
      );
    });

    res.status(200).json({
      generatedAt: now.toISOString(),
      speedingRuleName: SPEEDING_RULE_NAME,
      ranges
    });
  } catch (err) {
    console.error("GRAUS Fleet Kiosk performance API error:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
