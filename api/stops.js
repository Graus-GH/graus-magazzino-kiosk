/*
 * GRAUS Fleet Kiosk — /api/stops
 *
 * Detailed, per-vehicle breakdown of today's stops: start/end time,
 * duration, and location — matched against your Geotab client Zones where
 * possible, reverse-geocoded to a street address otherwise.
 */

const { geotabCall } = require("../lib/geotabClient");
const { computeStops } = require("../lib/stopDetection");
const { matchZone } = require("../lib/zoneMatcher");
const { reverseGeocode, resetRequestBudget } = require("../lib/geocoder");
const { mergeConsecutiveZoneStops } = require("../lib/mergeStops");

const MIN_STOP_SECONDS = 120;
const LOGRECORD_LIMIT_PER_DEVICE = 3000;
const OFFLINE_THRESHOLD_MS = 15 * 60 * 1000;

function fmtTime(d) {
  return d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
}

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
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const devices = await geotabCall("Get", {
      typeName: "Device",
      search: { fromDate: now.toISOString() }
    });

    const statuses = await geotabCall("Get", { typeName: "DeviceStatusInfo" });
    const statusByDevice = {};
    statuses.forEach(s => { statusByDevice[s.device.id] = s; });

    const results = await Promise.all(devices.map(async device => {
      // Whole per-device pipeline wrapped in try/catch: if ANYTHING fails
      // for this one vehicle (LogRecord fetch, zone match, geocoding), it
      // still shows up in the dashboard with an empty stop list instead of
      // silently disappearing from the response.
      try {
        let records = [];
        try {
          records = await geotabCall("Get", {
            typeName: "LogRecord",
            search: {
              deviceSearch: { id: device.id },
              fromDate: startOfToday.toISOString(),
              toDate: now.toISOString()
            },
            resultsLimit: LOGRECORD_LIMIT_PER_DEVICE
          });
        } catch (err) {
          console.error("LogRecord fetch failed for device", device.name, err.message);
        }

        const stops = computeStops(records, { minStopSeconds: MIN_STOP_SECONDS, now });

        // Attach zone/address to each raw stop first (still Date-based),
        // THEN merge consecutive same-zone stops, THEN format for display.
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

        // computeStops returns most-recent-first; merging needs chronological order
        withLocation.sort((a, b) => a.start - b.start);
        const merged = mergeConsecutiveZoneStops(withLocation);

        const stopsWithLocation = merged.map(s => ({
          start: s.start.toISOString(),
          end: s.end.toISOString(),
          startLabel: fmtTime(s.start),
          endLabel: s.ongoing ? "in corso" : fmtTime(s.end),
          durationSeconds: s.durationSeconds,
          ongoing: s.ongoing,
          lat: Math.round(s.lat * 10000) / 10000,
          lng: Math.round(s.lng * 10000) / 10000,
          zoneName: s.zoneName || null,
          address: s.address || null,
          mapUrl: `https://www.google.com/maps?q=${s.lat},${s.lng}`
        }));

        // Most-recent-first for display
        stopsWithLocation.sort((a, b) => new Date(b.start) - new Date(a.start));

        return {
          id: device.id,
          name: device.name,
          state: deviceState(statusByDevice[device.id], now),
          stopCount: stopsWithLocation.length,
          totalStopSeconds: stopsWithLocation.reduce((sum, s) => sum + s.durationSeconds, 0),
          stops: stopsWithLocation
        };
      } catch (err) {
        console.error("Stops pipeline failed entirely for device", device.name, err.message);
        return {
          id: device.id,
          name: device.name,
          state: deviceState(statusByDevice[device.id], now),
          stopCount: 0,
          totalStopSeconds: 0,
          stops: []
        };
      }
    }));

    results.sort((a, b) => a.name.localeCompare(b.name));

    res.status(200).json({
      generatedAt: now.toISOString(),
      vehicles: results
    });
  } catch (err) {
    console.error("GRAUS Fleet Kiosk stops API error:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
