/*
 * TEMPORARY debug endpoint — remove once the fuel-consumption investigation
 * is done. Not linked from any page.
 */

const { geotabCall } = require("../lib/geotabClient");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const days = Number(req.query && req.query.days) || 14;
    const deviceId = (req.query && req.query.deviceId) || "b22";
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Every StatusData reading this one device has sent, no diagnostic
    // filter — tells us what it actually reports instead of guessing IDs.
    const records = await geotabCall("Get", {
      typeName: "StatusData",
      search: { deviceSearch: { id: deviceId }, fromDate: since.toISOString() },
      resultsLimit: 20000
    });

    const diagIds = [...new Set(records.map(r => r.diagnostic.id))];

    const diagnostics = await geotabCall("Get", {
      typeName: "Diagnostic",
      search: {},
      resultsLimit: 50000
    });
    const nameById = {};
    diagnostics.forEach(d => { nameById[d.id] = d.name; });

    const seenDiagnostics = diagIds.map(id => ({
      id,
      name: nameById[id] || "(unknown)",
      count: records.filter(r => r.diagnostic.id === id).length
    }));

    res.status(200).json({
      deviceId,
      totalRecords: records.length,
      uniqueDiagnostics: seenDiagnostics.length,
      seenDiagnostics
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
