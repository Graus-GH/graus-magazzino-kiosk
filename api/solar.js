/*
 * GRAUS Fleet Kiosk — /api/solar
 *
 * Impianto fotovoltaico: potenza istantanea, energia prodotta oggi/questo
 * mese/quest'anno, e una curva di produzione media oraria per oggi —
 * lette dalla Monitoring API di SolarEdge (monitoringapi.solaredge.com).
 *
 * Credenziali (SOLAREDGE_API_KEY, SOLAREDGE_SITE_ID) vivono SOLO nelle
 * variabili d'ambiente di Vercel, mai nel codice — stesso principio delle
 * credenziali Geotab. Recuperabili dal portale SolarEdge: Admin → Site
 * Access → API Access.
 *
 * L'API gratuita di SolarEdge ha un budget limitato di chiamate al giorno
 * per sito — per questo il refresh lato client è ogni 15 minuti (vedi
 * solar.js), non ogni 60 secondi come la flotta.
 */

const SOLAREDGE_API_BASE = "https://monitoringapi.solaredge.com";

function romeDateTimeString(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function romeDateString(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(date);
}

async function solarEdgeCall(path, params) {
  const { SOLAREDGE_API_KEY, SOLAREDGE_SITE_ID } = process.env;
  if (!SOLAREDGE_API_KEY || !SOLAREDGE_SITE_ID) {
    throw new Error("Missing SOLAREDGE_API_KEY / SOLAREDGE_SITE_ID env vars");
  }

  const url = new URL(`${SOLAREDGE_API_BASE}/site/${SOLAREDGE_SITE_ID}${path}`);
  url.searchParams.set("api_key", SOLAREDGE_API_KEY);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));

  const resp = await fetch(url.toString());
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`SolarEdge API error (${resp.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    const now = new Date();
    const todayStart = romeDateTimeString(new Date(`${romeDateString(now)}T00:00:00`));
    const nowString = romeDateTimeString(now);

    const [overview, power] = await Promise.all([
      solarEdgeCall("/overview"),
      solarEdgeCall("/power", { startTime: todayStart, endTime: nowString })
    ]);

    const ov = overview.overview || {};
    const currentPowerKw = ov.currentPower ? Math.round(ov.currentPower.power) / 1000 : null;
    const todayEnergyKwh = ov.lastDayData ? Math.round(ov.lastDayData.energy) / 1000 : null;
    const monthEnergyKwh = ov.lastMonthData ? Math.round(ov.lastMonthData.energy) / 1000 : null;
    const yearEnergyKwh = ov.lastYearData ? Math.round(ov.lastYearData.energy) / 1000 : null;

    // Bucket the raw ~15-minute readings into an average-per-hour curve —
    // 24 bars is a lot more glanceable on a TV than ~96 fine-grained points.
    const hourly = {};
    const values = (power.power && power.power.values) || [];
    values.forEach(v => {
      if (v.value == null) return;
      const hour = parseInt(v.date.slice(11, 13), 10);
      if (!hourly[hour]) hourly[hour] = { sum: 0, count: 0 };
      hourly[hour].sum += v.value;
      hourly[hour].count += 1;
    });
    const chart = Array.from({ length: 24 }, (_, h) => ({
      label: String(h).padStart(2, "0"),
      kw: hourly[h] ? Math.round((hourly[h].sum / hourly[h].count) / 100) / 10 : 0
    }));

    res.status(200).json({
      generatedAt: now.toISOString(),
      currentPowerKw,
      todayEnergyKwh,
      monthEnergyKwh,
      yearEnergyKwh,
      chart
    });
  } catch (err) {
    console.error("GRAUS Fleet Kiosk solar API error:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
