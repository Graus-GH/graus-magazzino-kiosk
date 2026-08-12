/*
 * GRAUS Fleet Kiosk — /api/performance
 *
 * Analytics for a selectable time range: ?range=week|month|year (default week).
 *   - week:  last 7 days,        daily buckets
 *   - month: current month,      weekly buckets (Sett. 1-5)
 *   - year:  rolling 12 months,  monthly buckets
 *
 * Everything here comes from Trip data (distance, drivingDuration,
 * idlingDuration) — cheap to aggregate over long ranges since it doesn't
 * need raw GPS points. Speeding stays scoped to TODAY only (it does need
 * raw GPS, which is expensive over a long range) — this is a known,
 * deliberate limitation, noted in the API response.
 */

const { geotabCall } = require("../lib/geotabClient");
const { startOfDayRome, startOfMonthRome, dateKeyRome } = require("../lib/timezone");
const { parseDurationSeconds } = require("../lib/duration");
const { cleanName } = require("../lib/cleanName");
const { isRevealRequested, buildDriverNameMap } = require("../lib/driverReveal");
const { getSpeedingRuleId, SPEEDING_RULE_NAME } = require("../lib/speedingRule");

const TRIP_RESULTS_LIMIT = 50000;

function romeMonthLabel(date) {
  return new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", month: "short" }).format(date);
}

function buildRange(range, now) {
  if (range === "year") {
    const from = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    return { from, days: 365 };
  }
  if (range === "month") {
    const from = startOfMonthRome(now);
    return { from, days: Math.round((now - from) / 86400000) + 1 };
  }
  // week (default)
  const from = new Date(startOfDayRome(now).getTime() - 6 * 24 * 60 * 60 * 1000);
  return { from, days: 7 };
}

function bucketKeyAndLabel(range, tripStart, rangeFrom) {
  if (range === "year") {
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit" }).format(tripStart);
    return { key, label: romeMonthLabel(tripStart) };
  }
  if (range === "month") {
    const dayOfRange = Math.floor((tripStart - rangeFrom) / 86400000);
    const weekIndex = Math.floor(dayOfRange / 7) + 1;
    const key = "w" + weekIndex;
    return { key, label: "Sett. " + weekIndex };
  }
  // week: one bucket per calendar day
  const key = dateKeyRome(tripStart);
  const label = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", weekday: "short" }).format(tripStart);
  return { key, label };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    const now = new Date();
    const range = ["week", "month", "year"].includes(req.query && req.query.range) ? req.query.range : "week";
    const { from: rangeFrom, days } = buildRange(range, now);
    const startOfToday = startOfDayRome(now);

    const [devices, trips] = await Promise.all([
      geotabCall("Get", { typeName: "Device", search: { fromDate: now.toISOString() } }),
      geotabCall("Get", {
        typeName: "Trip",
        search: { fromDate: rangeFrom.toISOString() },
        resultsLimit: TRIP_RESULTS_LIMIT
      })
    ]);

    const revealDrivers = isRevealRequested(req);
    const driverNameByDeviceId = revealDrivers ? await buildDriverNameMap(trips) : {};

    // ---- Totals + chart buckets for the selected range ----
    let totalKm = 0;
    let totalDrivingSeconds = 0;
    let totalIdlingSeconds = 0;
    const buckets = {}; // key -> { label, km }
    const kmByDevice = {};

    trips.forEach(t => {
      const start = new Date(t.start);
      const dist = t.distance || 0;
      const drivingSec = parseDurationSeconds(t.drivingDuration);
      const idlingSec = parseDurationSeconds(t.idlingDuration);

      totalKm += dist;
      totalDrivingSeconds += drivingSec;
      totalIdlingSeconds += idlingSec;

      const { key, label } = bucketKeyAndLabel(range, start, rangeFrom);
      if (!buckets[key]) buckets[key] = { key, label, km: 0 };
      buckets[key].km += dist;

      const id = t.device.id;
      kmByDevice[id] = (kmByDevice[id] || 0) + dist;
    });

    // Ensure every expected bucket exists even with zero trips, in order
    const bucketOrder = [];
    if (range === "week") {
      for (let i = 6; i >= 0; i--) {
        const d = new Date(startOfToday.getTime() - i * 86400000);
        bucketOrder.push(bucketKeyAndLabel(range, d, rangeFrom).key);
      }
    } else if (range === "month") {
      const totalWeeks = Math.ceil(days / 7);
      for (let i = 1; i <= totalWeeks; i++) bucketOrder.push("w" + i);
    } else {
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        bucketOrder.push(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit" }).format(d));
      }
    }
    const chart = bucketOrder.map(key => buckets[key]
      ? { label: buckets[key].label, km: Math.round(buckets[key].km * 10) / 10 }
      : { label: fallbackLabel(range, key, rangeFrom, now), km: 0 });

    function fallbackLabel(range, key, rangeFrom, now) {
      if (range === "week") {
        const d = new Date(key + "T12:00:00");
        return new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", weekday: "short" }).format(d);
      }
      if (range === "month") return "Sett. " + key.replace("w", "");
      const d = new Date(key + "-01T12:00:00");
      return romeMonthLabel(d);
    }

    // ---- Km per vehicle, ranked ----
    const kmPerVehicle = devices
      .map(d => ({
        name: cleanName(d.name),
        driverName: revealDrivers ? (driverNameByDeviceId[d.id] || null) : undefined,
        km: Math.round((kmByDevice[d.id] || 0) * 10) / 10
      }))
      .sort((a, b) => b.km - a.km);

    // ---- Idling per vehicle for the selected range ----
    const idlingByDevice = {};
    trips.forEach(t => {
      const id = t.device.id;
      idlingByDevice[id] = (idlingByDevice[id] || 0) + parseDurationSeconds(t.idlingDuration);
    });
    const idling = devices
      .map(d => ({
        name: cleanName(d.name),
        driverName: revealDrivers ? (driverNameByDeviceId[d.id] || null) : undefined,
        idlingSeconds: Math.round(idlingByDevice[d.id] || 0)
      }))
      .sort((a, b) => a.idlingSeconds - b.idlingSeconds);

    // ---- Speeding: Geotab's own "Eccesso di velocità (nuova versione)" rule,
    // which compares actual speed against the posted road speed limit —
    // triggers at 20%+ over the limit for 5+ seconds. We just read the
    // ExceptionEvents Geotab already computed, scoped to the SAME range as
    // everything else on this page (no more "today only" limitation, since
    // this doesn't need raw GPS re-analysis on our end).
    let speedingResults = [];
    let speedingAvailable = false;
    try {
      const ruleId = await getSpeedingRuleId();
      if (ruleId) {
        speedingAvailable = true;
        const events = await geotabCall("Get", {
          typeName: "ExceptionEvent",
          search: {
            ruleSearch: { id: ruleId },
            fromDate: rangeFrom.toISOString(),
            toDate: now.toISOString()
          }
        });

        const byDevice = {};
        events.forEach(e => {
          const id = e.device && e.device.id;
          if (!id) return;
          if (!byDevice[id]) byDevice[id] = { eventCount: 0, totalDurationSeconds: 0 };
          byDevice[id].eventCount += 1;
          const durSec = (new Date(e.activeTo) - new Date(e.activeFrom)) / 1000;
          if (isFinite(durSec) && durSec > 0) byDevice[id].totalDurationSeconds += durSec;
        });

        speedingResults = devices
          .map(d => ({
            name: cleanName(d.name),
            driverName: revealDrivers ? (driverNameByDeviceId[d.id] || null) : undefined,
            eventCount: (byDevice[d.id] || {}).eventCount || 0,
            totalDurationSeconds: Math.round((byDevice[d.id] || {}).totalDurationSeconds || 0)
          }))
          .sort((a, b) => b.eventCount - a.eventCount);
      } else {
        console.error("Speeding rule not found by name:", SPEEDING_RULE_NAME);
      }
    } catch (err) {
      console.error("Speeding via ExceptionEvent failed:", err.message);
    }

    res.status(200).json({
      generatedAt: now.toISOString(),
      range,
      totals: {
        km: Math.round(totalKm),
        drivingHoursSeconds: Math.round(totalDrivingSeconds),
        idlingHoursSeconds: Math.round(totalIdlingSeconds),
        avgKmPerDay: days > 0 ? Math.round((totalKm / days) * 10) / 10 : 0
      },
      chart,
      kmPerVehicle,
      idling,
      speeding: speedingResults,
      speedingAvailable,
      speedingRuleName: SPEEDING_RULE_NAME
    });
  } catch (err) {
    console.error("GRAUS Fleet Kiosk performance API error:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
