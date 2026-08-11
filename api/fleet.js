/*
 * GRAUS Fleet Kiosk — /api/fleet
 *
 * Live overview: vehicle positions/status, today's distance, and today's
 * stop time/count computed from raw GPS points (see lib/stopDetection.js)
 * rather than Geotab's Trip.stopDuration, which can miss stops where the
 * engine was left running.
 */

const { geotabCall } = require("../lib/geotabClient");
const { computeStops } = require("../lib/stopDetection");
const { startOfDayRome } = require("../lib/timezone");
const { cleanName } = require("../lib/cleanName");
const { matchZone } = require("../lib/zoneMatcher");
const { reverseGeocode, resetRequestBudget } = require("../lib/geocoder");

const OFFLINE_THRESHOLD_MS = 15 * 60 * 1000;
const MIN_STOP_SECONDS = 120; // ignore traffic lights / brief pauses
const LOGRECORD_LIMIT_PER_DEVICE = 3000;

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  resetRequestBudget();

  try {
    const now = new Date();
    const startOfToday = startOfDayRome(now);

    const [devices, statuses, trips] = await Promise.all([
      geotabCall("Get", { typeName: "Device", search: { fromDate: now.toISOString() } }),
      geotabCall("Get", { typeName: "DeviceStatusInfo" }),
      geotabCall("Get", { typeName: "Trip", search: { fromDate: startOfToday.toISOString() } })
    ]);

    const statusByDevice = {};
    statuses.forEach(s => { statusByDevice[s.device.id] = s; });

    const distanceByDevice = {};
    trips.forEach(t => {
      const id = t.device.id;
      distanceByDevice[id] = (distanceByDevice[id] || 0) + (t.distance || 0);
    });

    // Fetch today's raw GPS points per device, in parallel, to detect real stops
    const logRecordsByDevice = {};
    await Promise.all(devices.map(async device => {
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
        logRecordsByDevice[device.id] = records;
      } catch (err) {
        console.error("LogRecord fetch failed for device", device.id, err.message);
        logRecordsByDevice[device.id] = [];
      }
    }));

    const vehicles = await Promise.all(devices.map(async device => {
      const status = statusByDevice[device.id];

      let state = "offline";
      if (status) {
        const lastUpdateAge = now - new Date(status.dateTime);
        if (lastUpdateAge > OFFLINE_THRESHOLD_MS) state = "offline";
        else if (status.isDriving) state = "moving";
        else state = "stopped";
      }

      const records = logRecordsByDevice[device.id] || [];
      const stops = computeStops(records, { minStopSeconds: MIN_STOP_SECONDS, now });
      const todayStopSeconds = stops.reduce((sum, s) => sum + s.durationSeconds, 0);

      const currentStop = stops.find(s => s.ongoing) || null;

      // Where a stopped vehicle actually is: a known client Zone if it
      // matches one, otherwise a reverse-geocoded street address.
      let location = null;
      if (state === "stopped" && status) {
        try {
          location = await matchZone(status.latitude, status.longitude);
          if (!location) location = await reverseGeocode(status.latitude, status.longitude);
        } catch (err) {
          console.error("Location lookup failed for device", device.name, err.message);
        }
      }

      return {
        id: device.id,
        name: cleanName(device.name),
        latitude: status ? status.latitude : null,
        longitude: status ? status.longitude : null,
        speed: status ? status.speed : 0,
        bearing: status ? status.bearing : null,
        lastUpdate: status ? status.dateTime : null,
        state,
        location,
        stopDurationMs: currentStop ? currentStop.durationSeconds * 1000 : null,
        todayStopSeconds: Math.round(todayStopSeconds),
        todayStopCount: stops.length,
        todayDistanceKm: Math.round((distanceByDevice[device.id] || 0) * 10) / 10
      };
    }));

    res.status(200).json({
      generatedAt: now.toISOString(),
      vehicles
    });
  } catch (err) {
    console.error("GRAUS Fleet Kiosk API error:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
