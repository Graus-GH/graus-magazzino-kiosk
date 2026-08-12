const { geotabCall } = require("./geotabClient");
const { cleanName } = require("./cleanName");

function isRevealRequested(req) {
  return !!(
    req.query && req.query.key &&
    process.env.DRIVER_REVEAL_KEY &&
    req.query.key === process.env.DRIVER_REVEAL_KEY
  );
}

// Given a list of Trip entities, returns { deviceId: "Driver Name" } for
// each device's MOST RECENT trip that has a real (non-"Unknown") driver
// assigned. Only call this when isRevealRequested(req) is true — it does
// an extra Geotab call (User list) that isn't needed otherwise.
async function buildDriverNameMap(trips) {
  const lastTripByDevice = {};
  trips.forEach(t => {
    const id = t.device.id;
    if (!lastTripByDevice[id] || new Date(t.stop) > new Date(lastTripByDevice[id].stop)) {
      lastTripByDevice[id] = t;
    }
  });

  const driverIds = [...new Set(
    Object.values(lastTripByDevice)
      .map(t => t.driver && t.driver.id)
      .filter(id => id && id !== "UnknownDriverId")
  )];

  const map = {};
  if (!driverIds.length) return map;

  try {
    const users = await geotabCall("Get", { typeName: "User", search: {} });
    const userById = {};
    users.forEach(u => { userById[u.id] = u; });

    Object.entries(lastTripByDevice).forEach(([deviceId, t]) => {
      const drvId = t.driver && t.driver.id;
      const u = drvId && userById[drvId];
      if (u) {
        const full = `${u.firstName || ""} ${u.lastName || ""}`.trim();
        map[deviceId] = cleanName(full || u.name || "");
      }
    });
  } catch (err) {
    console.error("Driver lookup failed:", err.message);
  }

  return map;
}

module.exports = { isRevealRequested, buildDriverNameMap };
