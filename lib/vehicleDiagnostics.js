/*
 * Fuel level, odometer and fuel consumption per device, read from Geotab's
 * StatusData. All use Geotab's well-known, fixed diagnostic IDs (not
 * per-database GUIDs) — the same IDs work in every MyGeotab database
 * regardless of language, so no name-based lookup is needed.
 *
 * An earlier version resolved these by matching Diagnostic.name text, which
 * was fragile: on an account with a fuller diagnostic catalog it actually
 * matched the WRONG diagnostic (e.g. "Second fuel level (right side)"
 * instead of "Fuel level (percentage)") — those bogus diagnostics never
 * report data for these vehicles, which is why every reading came back
 * "n/d".
 *
 * Fuel consumption (L/100km) has no single "here's the answer" diagnostic
 * on this fleet's hardware — DiagnosticAverageFuelEconomyId never reports
 * for these vehicles. MyGeotab's own "Consumo medio" widget computes it
 * instead from the cumulative fuel-used counter vs. distance over a
 * rolling window, which is what getFuelConsumptionByDevice() below
 * reproduces (verified against MyGeotab's own displayed value).
 */

const { geotabCall } = require("./geotabClient");

const DIAGNOSTIC_IDS = {
  fuelLevel: "DiagnosticFuelLevelId",
  odometer: "DiagnosticOdometerId",
  fuelUsed: "DiagnosticTotalFuelUsedId"
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

// Earliest AND latest StatusData reading per device in the window — needed
// to take a delta of a cumulative counter (fuel used, odometer), unlike
// getLatestStatusDataByDevice() above which only needs the newest point.
async function getFirstLastStatusDataByDevice(diagnosticId, sinceDate) {
  if (!diagnosticId) return {};

  const records = await geotabCall("Get", {
    typeName: "StatusData",
    search: { diagnosticSearch: { id: diagnosticId }, fromDate: sinceDate.toISOString() },
    resultsLimit: 50000
  });

  const byDevice = {};
  records.forEach(r => {
    const id = r.device.id;
    const t = new Date(r.dateTime);
    if (!byDevice[id]) {
      byDevice[id] = { first: r, last: r };
    } else {
      if (t < new Date(byDevice[id].first.dateTime)) byDevice[id].first = r;
      if (t > new Date(byDevice[id].last.dateTime)) byDevice[id].last = r;
    }
  });
  return byDevice;
}

// L/100km per device over `windowMs`, from the delta of the cumulative
// fuel-used counter divided by the delta of the odometer — same method
// MyGeotab's own "Consumo medio" widget uses. Needs at least two readings
// of both diagnostics spread across the window; returns null for a device
// otherwise (e.g. it barely moved, or hasn't reported yet).
async function getFuelConsumptionByDevice(windowMs) {
  const since = new Date(Date.now() - windowMs);
  const [fuelUsedByDevice, odometerByDevice] = await Promise.all([
    getFirstLastStatusDataByDevice(DIAGNOSTIC_IDS.fuelUsed, since),
    getFirstLastStatusDataByDevice(DIAGNOSTIC_IDS.odometer, since)
  ]);

  const result = {};
  Object.keys(fuelUsedByDevice).forEach(deviceId => {
    const fuel = fuelUsedByDevice[deviceId];
    const odo = odometerByDevice[deviceId];
    if (!odo) return;

    const deltaFuelL = fuel.last.data - fuel.first.data;
    const deltaDistKm = (odo.last.data - odo.first.data) / 1000;
    if (deltaDistKm <= 1 || deltaFuelL <= 0) return;

    result[deviceId] = Math.round((deltaFuelL / deltaDistKm) * 100 * 10) / 10;
  });
  return result;
}

module.exports = { getDiagnosticIds, getLatestStatusDataByDevice, getFuelConsumptionByDevice };
