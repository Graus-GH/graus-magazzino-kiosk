/*
 * GRAUS Fleet Kiosk — /api/fleet
 *
 * Live overview: vehicle positions/status, today's distance, and today's
 * stop time/count. Stop detection uses the same pipeline as /api/stops
 * (raw GPS + zone matching + consecutive same-zone merge) so the two
 * dashboards report consistent numbers. Stops at the GRAUS home base are
 * excluded from the stop-time/count totals — parking at base isn't a
 * meaningful "stop" for these metrics.
 */

const { geotabCall } = require("../lib/geotabClient");
const { computeStops } = require("../lib/stopDetection");
const { startOfDayRome } = require("../lib/timezone");
const { cleanName } = require("../lib/cleanName");
const { matchZone } = require("../lib/zoneMatcher");
const { reverseGeocode, resetRequestBudget } = require("../lib/geocoder");
const { mergeConsecutiveZoneStops } = require("../lib/mergeStops");
const { isHomeZone } = require("../lib/homeZone");
const { isRevealRequested, buildDriverNameMap } = require("../lib/driverReveal");
const { getSpeedingRuleId } = require("../lib/speedingRule");

const OFFLINE_THRESHOLD_MS = 15 * 60 * 1000;
const MIN_STOP_SECONDS = 120; // ignore traffic lights / brief pauses
const LOGRECORD_LIMIT_PER_DEVICE = 25000; // was 3000 — too low, was silently truncating busy driving days

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

    const revealDrivers = isRevealRequested(req);
    const driverNameByDeviceId = revealDrivers ? await buildDriverNameMap(trips) : {};

    // Speeding today, fleet-wide total — cheap to add here since it just
    // reads events Geotab already computed (via the "Eccesso di velocità
    // (nuova versione)" rule), no raw GPS re-analysis needed.
    let todaySpeedingEvents = 0;
    let speedingAvailable = false;
    try {
      const ruleId = await getSpeedingRuleId();
      if (ruleId) {
        speedingAvailable = true;
        const events = await geotabCall("Get", {
          typeName: "ExceptionEvent",
          search: {
            ruleSearch: { id: ruleId },
            fromDate: startOfToday.toISOString(),
            toDate: now.toISOString()
          }
        });
        todaySpeedingEvents = events.length;
      }
    } catch (err) {
      console.error("Speeding KPI fetch failed:", err.message);
    }

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
        if (records.length === LOGRECORD_LIMIT_PER_DEVICE) {
          console.error("LogRecord result possibly truncated (hit limit) for", device.name);
        }
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
      const rawStops = computeStops(records, { minStopSeconds: MIN_STOP_SECONDS, now });

      const stopsWithZone = await Promise.all(rawStops.map(async s => ({
        ...s,
        zoneName: await matchZone(s.lat, s.lng).catch(() => null)
      })));
      stopsWithZone.sort((a, b) => a.start - b.start);
      const merged = mergeConsecutiveZoneStops(stopsWithZone);

      const countedStops = merged.filter(s => !isHomeZone(s.zoneName));
      const todayStopSeconds = countedStops.reduce((sum, s) => sum + s.durationSeconds, 0);
      const todayStopCount = countedStops.length;

      const currentStop = merged.find(s => s.ongoing) || null;

      // Where a stopped vehicle actually is: its matched zone if there is
      // one (even the home base — this is live status, not a metric), or a
      // reverse-geocoded address otherwise.
      let location = null;
      if (state === "stopped" && status) {
        if (currentStop && currentStop.zoneName) {
          location = currentStop.zoneName;
        } else {
          try {
            location = await reverseGeocode(status.latitude, status.longitude);
          } catch (err) {
            console.error("Reverse geocode failed for device", device.name, err.message);
          }
        }
      }

      return {
        id: device.id,
        name: cleanName(device.name),
        driverName: revealDrivers ? (driverNameByDeviceId[device.id] || null) : undefined,
        latitude: status ? status.latitude : null,
        longitude: status ? status.longitude : null,
        speed: status ? status.speed : 0,
        bearing: status ? status.bearing : null,
        lastUpdate: status ? status.dateTime : null,
        state,
        location,
        stopDurationMs: currentStop ? currentStop.durationSeconds * 1000 : null,
        todayStopSeconds: Math.round(todayStopSeconds),
        todayStopCount,
        todayDistanceKm: Math.round((distanceByDevice[device.id] || 0) * 10) / 10
      };
    }));

    res.status(200).json({
      generatedAt: now.toISOString(),
      vehicles,
      todaySpeedingEvents,
      speedingAvailable
    });
  } catch (err) {
    console.error("GRAUS Fleet Kiosk API error:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
