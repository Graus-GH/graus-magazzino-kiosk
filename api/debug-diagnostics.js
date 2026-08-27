/*
 * TEMPORARY debug endpoint — remove once the fuel-consumption investigation
 * is done. Not linked from any page.
 */

const { geotabCall } = require("../lib/geotabClient");

// Candidate fixed/well-known Geotab diagnostic IDs for fuel-used-style data.
const CANDIDATES = {
  fuelUsed: "DiagnosticFuelUsedId",
  tripFuel: "DiagnosticTripFuelId",
  fuelConsumed: "DiagnosticFuelConsumedId",
  expectedFuelEconomy: "DiagnosticExpectedFuelEconomyId",
  instantFuelEconomy: "DiagnosticInstantaneousFuelEconomyId"
};

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const days = Number(req.query && req.query.days) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const results = {};
    for (const [key, diagId] of Object.entries(CANDIDATES)) {
      try {
        const records = await geotabCall("Get", {
          typeName: "StatusData",
          search: { diagnosticSearch: { id: diagId }, fromDate: since.toISOString() },
          resultsLimit: 5000
        });
        const byDevice = {};
        records.forEach(r => {
          const id = r.device.id;
          if (!byDevice[id]) byDevice[id] = [];
          byDevice[id].push(r);
        });
        results[key] = {
          diagId,
          totalRecords: records.length,
          deviceCount: Object.keys(byDevice).length,
          sample: records.slice(0, 3)
        };
      } catch (err) {
        results[key] = { diagId, error: err.message };
      }
    }

    const recentTrips = await geotabCall("Get", {
      typeName: "Trip",
      search: { fromDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() },
      resultsLimit: 5
    });

    res.status(200).json({ diagnosticCandidates: results, sampleTrips: recentTrips });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
