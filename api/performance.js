/*
 * GRAUS Fleet Kiosk — /api/performance
 *
 * Team-level performance data, no individual driver names involved:
 *   - progress toward a monthly km goal for the whole fleet
 *   - km driven per day over the last 7 days (trend)
 *   - today's idling time (engine on, not moving) per vehicle — uses
 *     Geotab's own Trip.idlingDuration, no extra configuration needed
 *
 * Monthly goal is configurable via the TEAM_MONTHLY_KM_GOAL env var
 * (Vercel → Settings → Environment Variables). Defaults to 5000 km/month
 * if not set.
 */

const { geotabCall } = require("../lib/geotabClient");

const DEFAULT_MONTHLY_GOAL_KM = 5000;

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const [devices, trips] = await Promise.all([
      geotabCall("Get", { typeName: "Device", search: { fromDate: now.toISOString() } }),
      geotabCall("Get", { typeName: "Trip", search: { fromDate: startOfMonth.toISOString() } })
    ]);

    const nameById = {};
    devices.forEach(d => { nameById[d.id] = d.name; });

    // Month-to-date total distance
    let monthKm = 0;
    trips.forEach(t => { monthKm += t.distance || 0; });

    // Last 7 calendar days (including today), km per day
    const dayBuckets = {};
    const dayOrder = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const key = d.toISOString().slice(0, 10);
      dayBuckets[key] = 0;
      dayOrder.push(key);
    }
    trips.forEach(t => {
      const key = new Date(t.start).toISOString().slice(0, 10);
      if (dayBuckets[key] !== undefined) dayBuckets[key] += (t.distance || 0);
    });
    const dailyKm = dayOrder.map(date => ({
      date,
      km: Math.round(dayBuckets[date] * 10) / 10
    }));

    // Today's idling time per device (engine on, not driving)
    const idlingByDevice = {};
    trips.forEach(t => {
      if (new Date(t.start) >= startOfToday) {
        const id = t.device.id;
        idlingByDevice[id] = (idlingByDevice[id] || 0) + (t.idlingDuration || 0);
      }
    });
    const idlingToday = devices
      .map(d => ({
        name: d.name,
        idlingSeconds: Math.round(idlingByDevice[d.id] || 0)
      }))
      .sort((a, b) => a.idlingSeconds - b.idlingSeconds);

    const monthGoalKm = Number(process.env.TEAM_MONTHLY_KM_GOAL) || DEFAULT_MONTHLY_GOAL_KM;

    res.status(200).json({
      generatedAt: now.toISOString(),
      monthGoalKm,
      monthKm: Math.round(monthKm),
      dailyKm,
      idlingToday
    });
  } catch (err) {
    console.error("GRAUS Fleet Kiosk performance API error:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
