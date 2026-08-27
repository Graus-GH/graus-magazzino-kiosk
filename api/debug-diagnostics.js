/*
 * TEMPORARY debug endpoint — remove once the fuel-consumption investigation
 * is done. Not linked from any page.
 */

const { geotabCall } = require("../lib/geotabClient");

async function firstLast(diagnosticId, deviceId, sinceDate) {
  const records = await geotabCall("Get", {
    typeName: "StatusData",
    search: { diagnosticSearch: { id: diagnosticId }, deviceSearch: { id: deviceId }, fromDate: sinceDate.toISOString() },
    resultsLimit: 50000
  });
  if (!records.length) return null;
  let first = records[0], last = records[0];
  records.forEach(r => {
    if (new Date(r.dateTime) < new Date(first.dateTime)) first = r;
    if (new Date(r.dateTime) > new Date(last.dateTime)) last = r;
  });
  return { count: records.length, first: { data: first.data, dateTime: first.dateTime }, last: { data: last.data, dateTime: last.dateTime } };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const days = Number(req.query && req.query.days) || 30;
    const deviceId = (req.query && req.query.deviceId) || "b22";
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [totalFuelUsed, deviceTotalFuel, odometer] = await Promise.all([
      firstLast("DiagnosticTotalFuelUsedId", deviceId, since),
      firstLast("DiagnosticDeviceTotalFuelId", deviceId, since),
      firstLast("DiagnosticOdometerId", deviceId, since)
    ]);

    function computeL100(fuel, odo) {
      if (!fuel || !odo) return null;
      const deltaFuelL = fuel.last.data - fuel.first.data;
      const deltaDistKm = (odo.last.data - odo.first.data) / 1000;
      if (deltaDistKm <= 0) return null;
      return { deltaFuelL, deltaDistKm, l100km: Math.round((deltaFuelL / deltaDistKm) * 100 * 10) / 10 };
    }

    res.status(200).json({
      deviceId,
      totalFuelUsed,
      deviceTotalFuel,
      odometer,
      computed: {
        fromTotalFuelUsed: computeL100(totalFuelUsed, odometer),
        fromDeviceTotalFuel: computeL100(deviceTotalFuel, odometer)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
