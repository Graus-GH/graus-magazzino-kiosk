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
const { parseDurationSeconds } = require("../lib/duration");
const { getDiagnosticIds, getLatestStatusDataByDevice } = require("../lib/vehicleDiagnostics");

const DIAGNOSTIC_LOOKBACK_MS = 48 * 60 * 60 * 1000; // devices don't all report fuel/odometer daily

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
    const drivingSecondsByDevice = {};
    trips.forEach(t => {
      const id = t.device.id;
      distanceByDevice[id] = (distanceByDevice[id] || 0) + (t.distance || 0);
      drivingSecondsByDevice[id] = (drivingSecondsByDevice[id] || 0) + parseDurationSeconds(t.drivingDuration);
    });
    const totalDrivingSeconds = Object.values(drivingSecondsByDevice).reduce((sum, s) => sum + s, 0);

    const revealDrivers = isRevealRequested(req);
    const driverNameByDeviceId = revealDrivers ? await buildDriverNameMap(trips) : {};

    // Fuel level / odometer / fuel economy — read straight from Geotab's
    // StatusData, one lookup per diagnostic covering the whole fleet at
    // once rather than per device. Whether these come back populated
    // depends on what the installed hardware actually reports; missing
    // data just means "n/d" for that vehicle, not a fetch error.
    let fuelLevelByDevice = {};
    let odometerByDevice = {};
    let fuelEconomyByDevice = {};
    try {
      const diagIds = await getDiagnosticIds();
      const since = new Date(now.getTime() - DIAGNOSTIC_LOOKBACK_MS);
      [fuelLevelByDevice, odometerByDevice, fuelEconomyByDevice] = await Promise.all([
        getLatestStatusDataByDevice(diagIds.fuelLevel, since),
        getLatestStatusDataByDevice(diagIds.odometer, since),
        getLatestStatusDataByDevice(diagIds.fuelEconomy, since)
      ]);
    } catch (err) {
      console.error("Vehicle diagnostics fetch failed:", err.message);
    }

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
      // reverse-geocoded address otherwise. Kept as separate zoneName/address
      // fields (like /api/stops) so the UI can badge a zone match the same
      // way Analisi Soste does, instead of just showing plain text.
      let zoneName = null;
      let address = null;
      if (state === "stopped" && status) {
        if (currentStop && currentStop.zoneName) {
          zoneName = currentStop.zoneName;
        } else {
          try {
            address = await reverseGeocode(status.latitude, status.longitude);
          } catch (err) {
            console.error("Reverse geocode failed for device", device.name, err.message);
          }
        }
      }
      const location = zoneName || address;

      // Fuel level comes through as either a 0–1 fraction or an already-a-
      // percentage 0–100 number depending on the device model — normalize
      // to a plain percentage either way.
      const fuelLevelRaw = fuelLevelByDevice[device.id] ? fuelLevelByDevice[device.id].data : null;
      const fuelLevelPercent = fuelLevelRaw == null ? null
        : Math.round((fuelLevelRaw <= 1 ? fuelLevelRaw * 100 : fuelLevelRaw) * 10) / 10;

      // Odometer diagnostic is in meters.
      const odometerRaw = odometerByDevice[device.id] ? odometerByDevice[device.id].data : null;
      const odometerKm = odometerRaw == null ? null : Math.round(odometerRaw / 100) / 10;

      const fuelEconomyRaw = fuelEconomyByDevice[device.id] ? fuelEconomyByDevice[device.id].data : null;

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
        zoneName,
        address,
        stopDurationMs: currentStop ? currentStop.durationSeconds * 1000 : null,
        todayStopSeconds: Math.round(todayStopSeconds),
        todayStopCount,
        todayDistanceKm: Math.round((distanceByDevice[device.id] || 0) * 10) / 10,
        todayDrivingSeconds: Math.round(drivingSecondsByDevice[device.id] || 0),
        fuelLevelPercent,
        odometerKm,
        fuelEconomy: fuelEconomyRaw == null ? null : Math.round(fuelEconomyRaw * 10) / 10
      };
    }));

    res.status(200).json({
      generatedAt: now.toISOString(),
      totalDrivingSeconds: Math.round(totalDrivingSeconds),
      vehicles,
      todaySpeedingEvents,
      speedingAvailable
    });
  } catch (err) {
    console.error("GRAUS Fleet Kiosk API error:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
