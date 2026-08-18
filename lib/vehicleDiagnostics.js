/*
 * Fuel level, odometer and fuel economy per device, read from Geotab's
 * StatusData (the same entity used for any OBD-II-derived diagnostic).
 *
 * Diagnostic IDs are resolved BY NAME (like speedingRule.js does for the
 * speeding rule) rather than hardcoded GUIDs, since the exact wording can
 * vary slightly by database/locale. Whether any of this actually reports
 * real values depends entirely on what the installed Geotab device model
 * supports for each vehicle — some trucks simply don't expose fuel data
 * over their OBD port. Verify against the real dashboard once deployed;
 * a diagnostic that comes back "n/d" for every vehicle likely means it
 * isn't supported by your hardware, not a bug here.
 */

const { geotabCall } = require("./geotabClient");

const CACHE_TTL_MS = 30 * 60 * 1000; // diagnostic IDs never change — cache generously

// Geotab's Diagnostic.name comes back in whatever language the database is
// set to — confirmed against this account: "Contachilometri grezzo" for
// odometer, "Livello carburante (percentuale)" for fuel level. Matching
// both the English and Italian forms so this doesn't silently break again
// if the account language ever changes.
const DIAGNOSTIC_MATCHERS = {
  fuelLevel: n => n.includes("fuel level") || n.includes("livello carburante"),
  odometer: n => (n.includes("odometer") && !n.includes("adjustment")) || n.includes("contachilometri"),
  fuelEconomy: n =>
    n.includes("average fuel economy") || (n.includes("fuel economy") && !n.includes("instantaneous")) ||
    n.includes("consumo carburante") || n.includes("economia carburante")
};

let cache = { byKey: null, fetchedAt: 0 };

function normalize(s) {
  return (s || "").normalize("NFC").trim().toLowerCase();
}

async function getDiagnosticIds() {
  const now = Date.now();
  if (cache.byKey && (now - cache.fetchedAt) < CACHE_TTL_MS) return cache.byKey;

  const diagnostics = await geotabCall("Get", { typeName: "Diagnostic", search: {} });
  const byKey = {};
  for (const key of Object.keys(DIAGNOSTIC_MATCHERS)) {
    const match = diagnostics.find(d => DIAGNOSTIC_MATCHERS[key](normalize(d.name)));
    byKey[key] = match ? match.id : null;
    if (!match) console.error("Diagnostic not found for", key, "— available names include:", diagnostics.slice(0, 5).map(d => d.name).join(" | "));
  }

  cache = { byKey, fetchedAt: now };
  return byKey;
}

// Latest StatusData reading per device for a given diagnostic, within a
// lookback window (devices don't all report on the same cadence, so "today
// only" can miss a vehicle that hasn't driven yet).
async function getLatestStatusDataByDevice(diagnosticId, sinceDate) {
  if (!diagnosticId) return {};

  const records = await geotabCall("Get", {
    typeName: "StatusData",
    search: { diagnosticSearch: { id: diagnosticId }, fromDate: sinceDate.toISOString() },
    resultsLimit: 50000
  });

  const latestByDevice = {};
  records.forEach(r => {
    const id = r.device.id;
    if (!latestByDevice[id] || new Date(r.dateTime) > new Date(latestByDevice[id].dateTime)) {
      latestByDevice[id] = r;
    }
  });
  return latestByDevice;
}

module.exports = { getDiagnosticIds, getLatestStatusDataByDevice };
