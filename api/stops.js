/*
 * GRAUS Fleet Kiosk — /api/stops
 *
 * Detailed, per-vehicle breakdown of today's stops: start/end time,
 * duration, and location — matched against your Geotab client Zones where
 * possible, otherwise returned as coordinates.
 *
 * Heavier to compute than /api/fleet (fetches full-day GPS points per
 * vehicle), so the kiosk page calling this should refresh less often
 * (e.g. every 3-5 minutes rather than every 60s).
 */

const { geotabCall } = require("../lib/geotabClient");
const { computeStops } = require("../lib/stopDetection");
const { matchZone } = require("../lib/zoneMatcher");

const MIN_STOP_SECONDS = 120;
const LOGRECORD_LIMIT_PER_DEVICE = 3000;

function fmtTime(d) {
  return d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const devices = await geotabCall("Get", {
      typeName: "Device",
      search: { fromDate: now.toISOString() }
    });

    const results = await Promise.all(devices.map(async device => {
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
        console.error("LogRecord fetch failed for device", device.id, err.message);
      }

      const stops = computeStops(records, { minStopSeconds: MIN_STOP_SECONDS, now });

      const stopsWithLocation = await Promise.all(stops.map(async s => {
        const zoneName = await matchZone(s.lat, s.lng);
        return {
          start: s.start.toISOString(),
          end: s.end.toISOString(),
          startLabel: fmtTime(s.start),
          endLabel: s.ongoing ? "in corso" : fmtTime(s.end),
          durationSeconds: s.durationSeconds,
          ongoing: s.ongoing,
          lat: Math.round(s.lat * 10000) / 10000,
          lng: Math.round(s.lng * 10000) / 10000,
          zoneName: zoneName || null,
          mapUrl: `https://www.google.com/maps?q=${s.lat},${s.lng}`
        };
      }));

      // Most recent first
      stopsWithLocation.sort((a, b) => new Date(b.start) - new Date(a.start));

      return {
        id: device.id,
        name: device.name,
        stopCount: stopsWithLocation.length,
        totalStopSeconds: stopsWithLocation.reduce((sum, s) => sum + s.durationSeconds, 0),
        stops: stopsWithLocation
      };
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
