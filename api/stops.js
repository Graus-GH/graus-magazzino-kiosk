/*
 * GRAUS Fleet Kiosk — /api/stops
 *
 * Detailed, per-vehicle breakdown of a day's stops: start/end time,
 * duration, and location — matched against your Geotab client Zones where
 * possible, reverse-geocoded to a street address otherwise. Also returns
 * km driven and engine (driving) hours for the day.
 *
 * totalStopSeconds/stopCount EXCLUDE stops at the GRAUS home base — being
 * parked at your own yard isn't a meaningful "stop" for these numbers.
 * The stop LIST still shows home-base entries (marked 🏠), just not
 * counted in the header totals.
 *
 * Optional query param: ?date=YYYY-MM-DD (Rome-local). Defaults to today.
 *
 * Driver names (?key=...): OFF by default. Only included in the response
 * if the request's `key` query param matches DRIVER_REVEAL_KEY (set in
 * Vercel env vars) — this is checked server-side, so the raw API response
 * never contains driver names unless the correct key was supplied. Never
 * shown on the public kiosk URL, only when someone who knows the key adds
 * it themselves.
 */

const { geotabCall } = require("../lib/geotabClient");
const { computeStops } = require("../lib/stopDetection");
const { matchZone } = require("../lib/zoneMatcher");
const { reverseGeocode, resetRequestBudget } = require("../lib/geocoder");
const { mergeConsecutiveZoneStops } = require("../lib/mergeStops");
const { startOfDayRome, startOfDateStringRome, dateKeyRome } = require("../lib/timezone");
const { cleanName } = require("../lib/cleanName");
const { parseDurationSeconds } = require("../lib/duration");
const { isHomeZone } = require("../lib/homeZone");

const MIN_STOP_SECONDS = 120;
const LOGRECORD_LIMIT_PER_DEVICE = 3000;
const OFFLINE_THRESHOLD_MS = 15 * 60 * 1000;

function deviceState(status, now) {
  if (!status) return "offline";
  const age = now - new Date(status.dateTime);
  if (age > OFFLINE_THRESHOLD_MS) return "offline";
  return status.isDriving ? "moving" : "stopped";
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  resetRequestBudget();

  try {
    const now = new Date();
    const requestedDate = req.query && req.query.date;
    const isToday = !requestedDate || requestedDate === dateKeyRome(now);
    const revealDrivers = !!(req.query && req.query.key &&
      process.env.DRIVER_REVEAL_KEY && req.query.key === process.env.DRIVER_REVEAL_KEY);

    const rangeStart = requestedDate ? startOfDateStringRome(requestedDate) : startOfDayRome(now);
    const rangeEnd = isToday
      ? now
      : new Date(rangeStart.getTime() + 24 * 60 * 60 * 1000);

    const devices = await geotabCall("Get", {
      typeName: "Device",
      search: { fromDate: now.toISOString() }
    });

    const statuses = isToday ? await geotabCall("Get", { typeName: "DeviceStatusInfo" }) : [];
    const statusByDevice = {};
    statuses.forEach(s => { statusByDevice[s.device.id] = s; });

    // Trip data for the same window: distance, engine (driving) hours, and
    // — only when unlocked — the driver of the most recent trip.
    const trips = await geotabCall("Get", {
      typeName: "Trip",
      search: { fromDate: rangeStart.toISOString(), toDate: rangeEnd.toISOString() }
    });
    const tripStatsByDevice = {};
    trips.forEach(t => {
      const id = t.device.id;
      if (!tripStatsByDevice[id]) tripStatsByDevice[id] = { distance: 0, drivingSeconds: 0, lastTrip: null };
      tripStatsByDevice[id].distance += (t.distance || 0);
      tripStatsByDevice[id].drivingSeconds += parseDurationSeconds(t.drivingDuration);
      if (!tripStatsByDevice[id].lastTrip || new Date(t.stop) > new Date(tripStatsByDevice[id].lastTrip.stop)) {
        tripStatsByDevice[id].lastTrip = t;
      }
    });

    let driverNameByDeviceId = {};
    if (revealDrivers) {
      try {
        const driverIds = [...new Set(
          Object.values(tripStatsByDevice)
            .map(t => t.lastTrip && t.lastTrip.driver && t.lastTrip.driver.id)
            .filter(id => id && id !== "UnknownDriverId")
        )];
        if (driverIds.length) {
          const users = await geotabCall("Get", { typeName: "User", search: {} });
          const userById = {};
          users.forEach(u => { userById[u.id] = u; });
          Object.entries(tripStatsByDevice).forEach(([deviceId, stat]) => {
            const drvId = stat.lastTrip && stat.lastTrip.driver && stat.lastTrip.driver.id;
            const u = drvId && userById[drvId];
            if (u) {
              const full = `${u.firstName || ""} ${u.lastName || ""}`.trim();
              driverNameByDeviceId[deviceId] = cleanName(full || u.name || "");
            }
          });
        }
      } catch (err) {
        console.error("Driver lookup failed:", err.message);
      }
    }

    const results = await Promise.all(devices.map(async device => {
      try {
        let records = [];
        try {
          records = await geotabCall("Get", {
            typeName: "LogRecord",
            search: {
              deviceSearch: { id: device.id },
              fromDate: rangeStart.toISOString(),
              toDate: rangeEnd.toISOString()
            },
            resultsLimit: LOGRECORD_LIMIT_PER_DEVICE
          });
        } catch (err) {
          console.error("LogRecord fetch failed for device", device.name, err.message);
        }

        const stops = computeStops(records, { minStopSeconds: MIN_STOP_SECONDS, now: rangeEnd });

        const withLocation = await Promise.all(stops.map(async s => {
          let zoneName = null;
          let address = null;
          try {
            zoneName = await matchZone(s.lat, s.lng);
            if (!zoneName) address = await reverseGeocode(s.lat, s.lng);
          } catch (err) {
            console.error("Location lookup failed for a stop on", device.name, err.message);
          }
          return { ...s, zoneName, address };
        }));

        withLocation.sort((a, b) => a.start - b.start);
        const merged = mergeConsecutiveZoneStops(withLocation);

        const stopsWithLocation = merged.map(s => ({
          start: s.start.toISOString(),
          end: s.end.toISOString(),
          durationSeconds: s.durationSeconds,
          ongoing: isToday ? s.ongoing : false,
          lat: Math.round(s.lat * 10000) / 10000,
          lng: Math.round(s.lng * 10000) / 10000,
          zoneName: s.zoneName || null,
          address: s.address || null,
          mapUrl: `https://www.google.com/maps?q=${s.lat},${s.lng}`
        }));

        stopsWithLocation.sort((a, b) => new Date(b.start) - new Date(a.start));

        const countedStops = stopsWithLocation.filter(s => !isHomeZone(s.zoneName));
        const tripStat = tripStatsByDevice[device.id] || { distance: 0, drivingSeconds: 0 };

        return {
          id: device.id,
          name: cleanName(device.name),
          state: deviceState(statusByDevice[device.id], now),
          latitude: statusByDevice[device.id] ? statusByDevice[device.id].latitude : null,
          longitude: statusByDevice[device.id] ? statusByDevice[device.id].longitude : null,
          driverName: revealDrivers ? (driverNameByDeviceId[device.id] || null) : undefined,
          distanceKm: Math.round(tripStat.distance * 10) / 10,
          drivingSeconds: Math.round(tripStat.drivingSeconds),
          stopCount: countedStops.length,
          totalStopSeconds: countedStops.reduce((sum, s) => sum + s.durationSeconds, 0),
          stops: stopsWithLocation
        };
      } catch (err) {
        console.error("Stops pipeline failed entirely for device", device.name, err.message);
        return {
          id: device.id,
          name: cleanName(device.name),
          state: deviceState(statusByDevice[device.id], now),
          latitude: statusByDevice[device.id] ? statusByDevice[device.id].latitude : null,
          longitude: statusByDevice[device.id] ? statusByDevice[device.id].longitude : null,
          driverName: revealDrivers ? (driverNameByDeviceId[device.id] || null) : undefined,
          distanceKm: 0,
          drivingSeconds: 0,
          stopCount: 0,
          totalStopSeconds: 0,
          stops: []
        };
      }
    }));

    results.sort((a, b) => a.name.localeCompare(b.name));

    res.status(200).json({
      generatedAt: now.toISOString(),
      date: requestedDate || dateKeyRome(now),
      isToday,
      vehicles: results
    });
  } catch (err) {
    console.error("GRAUS Fleet Kiosk stops API error:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
