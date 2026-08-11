/*
 * GRAUS Fleet Kiosk — serverless data proxy
 *
 * Runs on Vercel. Authenticates to Geotab using a SERVICE ACCOUNT (never
 * exposed to the browser) and returns a ready-to-render summary of the
 * fleet: vehicle positions, status, and today's stop history.
 *
 * Required environment variables (set in Vercel Project Settings → Environment Variables):
 *   GEOTAB_DATABASE  — e.g. "grau01"
 *   GEOTAB_USERNAME  — service account email
 *   GEOTAB_PASSWORD  — service account password
 *
 * Recommendation: create a DEDICATED read-only user in MyGeotab for this
 * (Administration → Users → Add User), rather than reusing a personal
 * login — easier to rotate/revoke, and limits blast radius if leaked.
 */

const GEOTAB_ENTRY = "https://my.geotab.com/apiv1";
const OFFLINE_THRESHOLD_MS = 15 * 60 * 1000;

// Cached across warm serverless invocations (reset on cold start — fine,
// we just re-authenticate).
let session = null;

async function authenticate() {
  const { GEOTAB_DATABASE, GEOTAB_USERNAME, GEOTAB_PASSWORD } = process.env;
  if (!GEOTAB_DATABASE || !GEOTAB_USERNAME || !GEOTAB_PASSWORD) {
    throw new Error("Missing GEOTAB_DATABASE / GEOTAB_USERNAME / GEOTAB_PASSWORD env vars");
  }

  const resp = await fetch(GEOTAB_ENTRY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "Authenticate",
      params: {
        database: GEOTAB_DATABASE,
        userName: GEOTAB_USERNAME,
        password: GEOTAB_PASSWORD
      }
    })
  });

  const data = await resp.json();
  if (data.error) {
    throw new Error("Geotab authentication failed: " + (data.error.message || JSON.stringify(data.error)));
  }

  const result = data.result;
  const server = (result.path && result.path !== "ThisServer")
    ? `https://${result.path}/apiv1`
    : GEOTAB_ENTRY;

  session = { server, credentials: result.credentials };
  return session;
}

async function geotabCall(method, params) {
  if (!session) await authenticate();

  const doCall = async () => {
    const resp = await fetch(session.server, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params: { ...params, credentials: session.credentials } })
    });
    return resp.json();
  };

  let data = await doCall();

  // Session expired — re-authenticate once and retry
  const isAuthError = data.error && /invaliduser|sessionid|not authenticated/i.test(
    (data.error.name || "") + " " + (data.error.message || "")
  );
  if (isAuthError) {
    await authenticate();
    data = await doCall();
  }

  if (data.error) {
    throw new Error(method + " failed: " + (data.error.message || JSON.stringify(data.error)));
  }
  return data.result;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const [devices, statuses, trips] = await Promise.all([
      geotabCall("Get", { typeName: "Device", search: { fromDate: now.toISOString() } }),
      geotabCall("Get", { typeName: "DeviceStatusInfo" }),
      geotabCall("Get", { typeName: "Trip", search: { fromDate: startOfToday.toISOString() } })
    ]);

    const statusByDevice = {};
    statuses.forEach(s => { statusByDevice[s.device.id] = s; });

    // Group today's trips per device, sorted chronologically
    const tripsByDevice = {};
    trips.forEach(t => {
      const id = t.device.id;
      if (!tripsByDevice[id]) tripsByDevice[id] = [];
      tripsByDevice[id].push(t);
    });
    Object.values(tripsByDevice).forEach(list =>
      list.sort((a, b) => new Date(a.stop) - new Date(b.stop))
    );

    const vehicles = devices.map(device => {
      const status = statusByDevice[device.id];
      const deviceTrips = tripsByDevice[device.id] || [];
      const lastTrip = deviceTrips[deviceTrips.length - 1];

      let state = "offline";
      let stopSince = null;

      if (status) {
        const lastUpdateAge = now - new Date(status.dateTime);
        if (lastUpdateAge > OFFLINE_THRESHOLD_MS) {
          state = "offline";
        } else if (status.isDriving) {
          state = "moving";
        } else {
          state = "stopped";
          stopSince = lastTrip ? new Date(lastTrip.stop) : new Date(status.dateTime);
        }
      }

      // Today's stop stats: total stopped time (sum of stopDuration between
      // trips) and stop count, excluding very short stops (<2 min, e.g.
      // traffic lights) so the numbers reflect meaningful pauses.
      const MIN_STOP_SECONDS = 120;
      let totalStopSeconds = 0;
      let stopCount = 0;
      deviceTrips.forEach(t => {
        if (t.stopDuration && t.stopDuration >= MIN_STOP_SECONDS) {
          totalStopSeconds += t.stopDuration;
          stopCount += 1;
        }
      });
      if (state === "stopped" && stopSince) {
        const ongoingSeconds = (now - stopSince) / 1000;
        if (ongoingSeconds >= MIN_STOP_SECONDS) {
          totalStopSeconds += ongoingSeconds;
          stopCount += 1;
        }
      }

      const totalDistanceKm = deviceTrips.reduce((sum, t) => sum + (t.distance || 0), 0);

      return {
        id: device.id,
        name: device.name,
        latitude: status ? status.latitude : null,
        longitude: status ? status.longitude : null,
        speed: status ? status.speed : 0,
        state,
        stopDurationMs: stopSince ? now - stopSince : null,
        todayStopSeconds: Math.round(totalStopSeconds),
        todayStopCount: stopCount,
        todayDistanceKm: Math.round(totalDistanceKm * 10) / 10
      };
    });

    res.status(200).json({
      generatedAt: now.toISOString(),
      vehicles
    });
  } catch (err) {
    console.error("GRAUS Fleet Kiosk API error:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
