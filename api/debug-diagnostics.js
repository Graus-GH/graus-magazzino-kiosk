/*
 * TEMPORARY debug endpoint — remove once the fuel/odometer/consumption
 * "n/d" investigation is done. Not linked from any page.
 */

const { geotabCall } = require("../lib/geotabClient");
const { getDiagnosticIds, getLatestStatusDataByDevice } = require("../lib/vehicleDiagnostics");

const LOOKBACK_MS = 48 * 60 * 60 * 1000;

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const diagIds = await getDiagnosticIds();
    const since = new Date(Date.now() - LOOKBACK_MS);

    const [fuelLevel, odometer, fuelEconomy] = await Promise.all([
      getLatestStatusDataByDevice(diagIds.fuelLevel, since),
      getLatestStatusDataByDevice(diagIds.odometer, since),
      getLatestStatusDataByDevice(diagIds.fuelEconomy, since)
    ]);

    const allDiagnostics = await geotabCall("Get", { typeName: "Diagnostic", search: {}, resultsLimit: 50000 });
    const byId = {};
    allDiagnostics.forEach(d => { byId[d.id] = d.name; });

    const exactCandidates = allDiagnostics
      .filter(d => {
        const n = (d.name || "").toLowerCase();
        return n === "fuel level (percentage)" || n === "fuel level" ||
               n === "average fuel economy" ||
               (n.includes("odometer") && !n.includes("adjustment") && !n.includes("second")) ||
               n.includes("contachilometri") || n.includes("livello carburante") || n.includes("economia carburante");
      })
      .map(d => ({ id: d.id, name: d.name }));

    res.status(200).json({
      resolvedNames: {
        fuelLevel: byId[diagIds.fuelLevel] || null,
        odometer: byId[diagIds.odometer] || null,
        fuelEconomy: byId[diagIds.fuelEconomy] || null
      },
      diagIds,
      counts: {
        fuelLevel: Object.keys(fuelLevel).length,
        odometer: Object.keys(odometer).length,
        fuelEconomy: Object.keys(fuelEconomy).length
      },
      sampleReading: {
        fuelLevel: Object.values(fuelLevel)[0] || null,
        odometer: Object.values(odometer)[0] || null,
        fuelEconomy: Object.values(fuelEconomy)[0] || null
      },
      totalDiagnostics: allDiagnostics.length,
      exactCandidates
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
