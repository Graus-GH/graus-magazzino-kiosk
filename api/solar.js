/*
 * GRAUS Fleet Kiosk — /api/solar
 *
 * Impianto fotovoltaico: potenza istantanea, e tre viste di dettaglio
 * energia (oggi/orario, ultimi 30 giorni/giornaliero, ultimi 12 mesi) con
 * la stessa scomposizione produzione/autoconsumo/rete mostrata dal
 * pannello "Energia Impianto" del portale SolarEdge — lette dalla
 * Monitoring API (monitoringapi.solaredge.com).
 *
 * Credenziali (SOLAREDGE_API_KEY, SOLAREDGE_SITE_ID) vivono SOLO nelle
 * variabili d'ambiente di Vercel, mai nel codice — stesso principio delle
 * credenziali Geotab. Recuperabili dal portale SolarEdge: Admin → Site
 * Access → API Access.
 *
 * La scomposizione richiede che il vostro impianto abbia anche un
 * contatore di consumo configurato in SolarEdge (non solo produzione) —
 * se non c'è, i meter Consumption/SelfConsumption/FeedIn/Purchased
 * torneranno vuoti e i relativi KPI/barre resteranno a 0.
 *
 * 4 chiamate per refresh (overview + 3 energyDetails) — l'API gratuita di
 * SolarEdge ha un budget limitato al giorno per sito, per questo il
 * refresh lato client è ogni ~20 minuti (vedi solar.js), non ogni 60
 * secondi come la flotta.
 */

const { startOfDayRome, startOfMonthRome } = require("../lib/timezone");

const SOLAREDGE_API_BASE = "https://monitoringapi.solaredge.com";
const METERS = "Production,Consumption,SelfConsumption,FeedIn,Purchased";

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

// Midnight on the 1st of the Rome-local month that's `monthsBack` months
// before `now` — same "noon UTC is safely inside the target day" trick
// timezone.js already uses, just walked back a further N months first.
function monthsAgoStartRome(now, monthsBack) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = parseInt(parts.find(p => p.type === "year").value, 10);
  const month = parseInt(parts.find(p => p.type === "month").value, 10);

  let targetMonth = month - monthsBack;
  let targetYear = year;
  while (targetMonth <= 0) { targetMonth += 12; targetYear -= 1; }

  const noonUtc = new Date(`${targetYear}-${String(targetMonth).padStart(2, "0")}-15T12:00:00Z`);
  return startOfMonthRome(noonUtc);
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

function meterSeriesByType(energyDetails) {
  const map = {};
  ((energyDetails && energyDetails.meters) || []).forEach(m => { map[m.type] = m.values || []; });
  return map;
}

function sumSeries(series, type) {
  return (series[type] || []).reduce((sum, v) => sum + (v.value || 0), 0);
}

function buildKpis(energyDetails) {
  const series = meterSeriesByType(energyDetails);
  const production = sumSeries(series, "Production");
  const consumption = sumSeries(series, "Consumption");
  const selfConsumption = sumSeries(series, "SelfConsumption");
  const purchased = sumSeries(series, "Purchased");
  const feedIn = sumSeries(series, "FeedIn");

  return {
    productionKwh: Math.round(production / 1000),
    consumptionKwh: Math.round(consumption / 1000),
    selfConsumptionRate: production > 0 ? Math.round((selfConsumption / production) * 100) : null,
    purchasedKwh: Math.round(purchased / 1000),
    feedInKwh: Math.round(feedIn / 1000)
  };
}

function buildFlowChart(energyDetails, labelFn) {
  const series = meterSeriesByType(energyDetails);
  const dates = (series.Production || []).map(v => v.date);

  const lookup = type => {
    const m = new Map((series[type] || []).map(v => [v.date, v.value]));
    return date => {
      const v = m.get(date);
      return v == null ? 0 : Math.round(v / 100) / 10; // Wh -> kWh, 1 decimal
    };
  };
  const getProduction = lookup("Production");
  const getConsumption = lookup("Consumption");
  const getSelfConsumption = lookup("SelfConsumption");
  const getFeedIn = lookup("FeedIn");
  const getPurchased = lookup("Purchased");

  return dates.map(date => ({
    label: labelFn(date),
    production: getProduction(date),
    consumption: getConsumption(date),
    selfConsumption: getSelfConsumption(date),
    feedIn: getFeedIn(date),
    purchased: getPurchased(date)
  }));
}

function hourLabel(dateStr) {
  return dateStr.slice(11, 13);
}
function dayLabel(dateStr) {
  const [, m, d] = dateStr.slice(0, 10).split("-");
  return `${d}/${m}`;
}
function monthLabel(dateStr) {
  const d = new Date(dateStr.slice(0, 10) + "T12:00:00Z");
  return new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", month: "short" }).format(d);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    const now = new Date();
    const todayStart = startOfDayRome(now);
    const last30Start = new Date(startOfDayRome(now).getTime() - 29 * 24 * 60 * 60 * 1000);
    const monthlyStart = monthsAgoStartRome(now, 11);

    const [overview, todayDetails, last30Details, monthlyDetails] = await Promise.all([
      solarEdgeCall("/overview"),
      solarEdgeCall("/energyDetails", { meters: METERS, timeUnit: "HOUR", startTime: romeDateTimeString(todayStart), endTime: romeDateTimeString(now) }),
      solarEdgeCall("/energyDetails", { meters: METERS, timeUnit: "DAY", startTime: romeDateTimeString(last30Start), endTime: romeDateTimeString(now) }),
      solarEdgeCall("/energyDetails", { meters: METERS, timeUnit: "MONTH", startTime: romeDateTimeString(monthlyStart), endTime: romeDateTimeString(now) })
    ]);

    const currentPowerKw = (overview.overview && overview.overview.currentPower)
      ? Math.round(overview.overview.currentPower.power) / 1000
      : null;

    res.status(200).json({
      generatedAt: now.toISOString(),
      currentPowerKw,
      ranges: {
        today: {
          kpis: buildKpis(todayDetails.energyDetails),
          chart: buildFlowChart(todayDetails.energyDetails, hourLabel)
        },
        last30: {
          kpis: buildKpis(last30Details.energyDetails),
          chart: buildFlowChart(last30Details.energyDetails, dayLabel)
        },
        monthly: {
          kpis: buildKpis(monthlyDetails.energyDetails),
          chart: buildFlowChart(monthlyDetails.energyDetails, monthLabel)
        }
      }
    });
  } catch (err) {
    console.error("GRAUS Fleet Kiosk solar API error:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
