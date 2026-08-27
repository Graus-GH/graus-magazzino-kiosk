/*
 * TEMPORARY debug endpoint — remove once the fuel/odometer/consumption
 * "n/d" investigation is done. Not linked from any page.
 */

const { getDiagnosticIds, getLatestStatusDataByDevice } = require("../lib/vehicleDiagnostics");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const lookbackDays = Number(req.query && req.query.days) || 2;
    const diagIds = await getDiagnosticIds();
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

    const [fuelLevel, odometer, fuelEconomy] = await Promise.all([
      getLatestStatusDataByDevice(diagIds.fuelLevel, since),
      getLatestStatusDataByDevice(diagIds.odometer, since),
      getLatestStatusDataByDevice(diagIds.fuelEconomy, since)
    ]);

    res.status(200).json({
      diagIds,
      counts: {
        fuelLevel: Object.keys(fuelLevel).length,
        odometer: Object.keys(odometer).length,
        fuelEconomy: Object.keys(fuelEconomy).length
      },
      sampleReadings: {
        fuelLevel: Object.values(fuelLevel).slice(0, 3),
        odometer: Object.values(odometer).slice(0, 3),
        fuelEconomy: Object.values(fuelEconomy).slice(0, 3)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
