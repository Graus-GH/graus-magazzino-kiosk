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

const SPEEDING_THRESHOLD_KMH = Number(process.env.SPEEDING_THRESHOLD_KMH) || 90;
const LOGRECORD_LIMIT_PER_DEVICE = 3000;
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

    // ---- Speeding: always TODAY only (needs raw GPS — expensive over a range) ----
    const speedingResults = await Promise.all(devices.map(async device => {
      try {
        const records = await geotabCall("Get", {
          typeName: "LogRecord",
          search: {
            deviceSearch: { id: device.id },
            fromDate: startOfToday.toISOString(),
            toDate: now.toISOString()
          },
          resultsLimit: LOGRECORD_LIMIT_PER_DEVICE
        });

        let eventCount = 0;
        let maxSpeed = 0;
        let wasOver = false;
        records.forEach(r => {
          const speed = r.speed || 0;
          if (speed > maxSpeed) maxSpeed = speed;
          if (speed > SPEEDING_THRESHOLD_KMH) {
            if (!wasOver) eventCount += 1;
            wasOver = true;
          } else {
            wasOver = false;
          }
        });

        return { name: cleanName(device.name), eventCount, maxSpeedKmh: Math.round(maxSpeed) };
      } catch (err) {
        console.error("Speeding check failed for device", device.name, err.message);
        return { name: cleanName(device.name), eventCount: 0, maxSpeedKmh: 0 };
      }
    }));
    speedingResults.sort((a, b) => b.eventCount - a.eventCount);

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
      speedThresholdKmh: SPEEDING_THRESHOLD_KMH
    });
  } catch (err) {
    console.error("GRAUS Fleet Kiosk performance API error:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
