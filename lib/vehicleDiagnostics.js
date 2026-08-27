/*
 * Fuel level, odometer and fuel economy per device, read from Geotab's
 * StatusData. These three use Geotab's well-known, fixed diagnostic IDs
 * (not per-database GUIDs) — the same three IDs work in every MyGeotab
 * database regardless of language, so no name-based lookup is needed.
 *
 * An earlier version resolved these by matching Diagnostic.name text, which
 * was fragile: on an account with a fuller diagnostic catalog it actually
 * matched the WRONG diagnostic (e.g. "Second fuel level (right side)"
 * instead of "Fuel level (percentage)", "Power specific fuel economy"
 * instead of "Average fuel economy") — those bogus diagnostics never report
 * data for these vehicles, which is why every reading came back "n/d".
 */

const { geotabCall } = require("./geotabClient");

const DIAGNOSTIC_IDS = {
  fuelLevel: "DiagnosticFuelLevelId",
  odometer: "DiagnosticOdometerId",
  fuelEconomy: "DiagnosticAverageFuelEconomyId"
};

async function getDiagnosticIds() {
  return DIAGNOSTIC_IDS;
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
