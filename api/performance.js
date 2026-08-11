/*
 * GRAUS Fleet Kiosk — /api/performance
 *
 * Team-level performance data:
 *   - km driven this month and this week
 *   - km per day over the last 7 days (trend)
 *   - idling time (engine on, not moving) per vehicle — today/week/month,
 *     from Geotab's own Trip.idlingDuration
 *   - speeding: a FLAT threshold proxy (not tied to real posted limits —
 *     see SPEEDING_THRESHOLD_KMH below), counted from today's raw GPS
 *     points. For accurate results tied to actual speed limits, configure
 *     a "Speeding" Rule in MyGeotab and switch this to read ExceptionEvent
 *     instead — flagged here as a known follow-up, not done yet.
 */

const { geotabCall } = require("../lib/geotabClient");
const { startOfDayRome, startOfMonthRome, dateKeyRome } = require("../lib/timezone");

const SPEEDING_THRESHOLD_KMH = Number(process.env.SPEEDING_THRESHOLD_KMH) || 90;
const LOGRECORD_LIMIT_PER_DEVICE = 3000;

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    const now = new Date();
    const startOfMonth = startOfMonthRome(now);
    const startOfToday = startOfDayRome(now);
    const startOfWeekWindow = new Date(startOfDayRome(now).getTime() - 6 * 24 * 60 * 60 * 1000);

    const [devices, trips] = await Promise.all([
      geotabCall("Get", { typeName: "Device", search: { fromDate: now.toISOString() } }),
      geotabCall("Get", { typeName: "Trip", search: { fromDate: startOfMonth.toISOString() } })
    ]);

    // ---- Km this month / this week / daily trend ----
    let monthKm = 0;
    let weekKm = 0;
    const dayBuckets = {};
    const dayOrder = [];
    for (let i = 6; i >= 0; i--) {
      const key = dateKeyRome(new Date(startOfToday.getTime() - i * 24 * 60 * 60 * 1000));
      dayBuckets[key] = 0;
      dayOrder.push(key);
    }

    trips.forEach(t => {
      const dist = t.distance || 0;
      monthKm += dist;
      if (new Date(t.start) >= startOfWeekWindow) weekKm += dist;
      const key = dateKeyRome(new Date(t.start));
      if (dayBuckets[key] !== undefined) dayBuckets[key] += dist;
    });

    const dailyKm = dayOrder.map(date => ({
      date,
      km: Math.round(dayBuckets[date] * 10) / 10
    }));

    // ---- Idling per device: today / week / month ----
    const idlingByDevice = {};
    trips.forEach(t => {
      const id = t.device.id;
      if (!idlingByDevice[id]) idlingByDevice[id] = { today: 0, week: 0, month: 0 };
      const dur = t.idlingDuration || 0;
      idlingByDevice[id].month += dur;
      if (new Date(t.start) >= startOfWeekWindow) idlingByDevice[id].week += dur;
      if (new Date(t.start) >= startOfToday) idlingByDevice[id].today += dur;
    });

    const idling = devices.map(d => ({
      name: d.name,
      todaySeconds: Math.round((idlingByDevice[d.id] || {}).today || 0),
      weekSeconds: Math.round((idlingByDevice[d.id] || {}).week || 0),
      monthSeconds: Math.round((idlingByDevice[d.id] || {}).month || 0)
    })).sort((a, b) => a.monthSeconds - b.monthSeconds);

    // ---- Speeding (today only, flat threshold proxy) ----
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
            if (!wasOver) eventCount += 1; // count contiguous excess as ONE event
            wasOver = true;
          } else {
            wasOver = false;
          }
        });

        return { name: device.name, eventCount, maxSpeedKmh: Math.round(maxSpeed) };
      } catch (err) {
        console.error("Speeding check failed for device", device.name, err.message);
        return { name: device.name, eventCount: 0, maxSpeedKmh: 0 };
      }
    }));

    speedingResults.sort((a, b) => b.eventCount - a.eventCount);

    res.status(200).json({
      generatedAt: now.toISOString(),
      monthKm: Math.round(monthKm),
      weekKm: Math.round(weekKm),
      dailyKm,
      idling,
      speeding: speedingResults,
      speedThresholdKmh: SPEEDING_THRESHOLD_KMH
    });
  } catch (err) {
    console.error("GRAUS Fleet Kiosk performance API error:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
