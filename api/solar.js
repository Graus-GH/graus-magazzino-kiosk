/*
 * GRAUS Fleet Kiosk — /api/solar
 *
 * Impianto fotovoltaico: potenza istantanea e quattro viste di dettaglio
 * energia (ieri e oggi ogni 15 minuti, ultimi 30 giorni/giornaliero, ultimi
 * 12 mesi/mensile) con la scomposizione produzione/autoconsumo/rete del portale SolarEdge — lette
 * dalla Monitoring API V2 (monitoringapi.solaredge.com/v2), OAuth "Site
 * Access". La V1 con API key viene spenta il 1 novembre 2026.
 *
 * Come ricostruiamo la scomposizione (verificato sui dati reali: i totali
 * coincidono con l'overview del sito):
 *   produzione   = energia inverter
 *   immessa      = contatore, exportEnergy
 *   prelevata    = contatore, importEnergy
 *   autoconsumo  = produzione - immessa
 *   consumo      = autoconsumo + prelevata
 *
 * Crediti: il piano gratuito dà 2.000 chiamate/mese (1 credito a chiamata).
 * Per questo le TV NON chiamano mai SolarEdge direttamente: questa funzione
 * serve l'ultimo risultato salvato su Redis e lo aggiorna solo quando serve
 * e solo in orario di lettura (lun-ven 7:30-18:30, sab 7:30-13:00, ora di
 * Roma): "oggi" ogni 30 minuti (2 chiamate), ultimi 30 giorni / 12 mesi ogni
 * 5 ore (4 chiamate), "ieri" una volta al giorno (2 chiamate, il dato è
 * definitivo). Circa 1.350 crediti/mese, più un tetto di sicurezza.
 *
 * Token: l'access token dura 2 ore e il refresh token ruota a ogni rinnovo
 * (il vecchio diventa invalido), quindi la coppia più recente vive su Redis.
 *
 * Variabili d'ambiente (SOLO su Vercel, mai nel codice):
 *   SOLAREDGE_CLIENT_ID, SOLAREDGE_CLIENT_SECRET, SOLAREDGE_SITE_ID
 *   SOLAREDGE_REFRESH_TOKEN  (solo per il primo avvio, poi basta Redis)
 *   KV_REST_API_URL, KV_REST_API_TOKEN  (iniettate dall'integrazione Upstash)
 */

const {
  startOfDayRome, startOfMonthRome, isoWeekdayRome, dateKeyRome, addDaysRome
} = require("../lib/timezone");
const redis = require("../lib/upstash");

const API_BASE = "https://monitoringapi.solaredge.com/v2";

const KEY_TOKENS = "solaredge:tokens";
const KEY_TOKEN_LOCK = "solaredge:token-lock";
const KEY_CACHE = "solaredge:cache";
const KEY_REFRESH_LOCK = "solaredge:refresh-lock";
const KEY_FAILURE = "solaredge:failure";

const TODAY_TTL_MS = 30 * 60 * 1000;
const HISTORY_TTL_MS = 5 * 60 * 60 * 1000;
const POWER_MAX_AGE_MS = 60 * 60 * 1000;
const TOKEN_KEEPALIVE_MS = 7 * 24 * 60 * 60 * 1000; // refresh token lives 30 days
const FAILURE_BACKOFF_SECONDS = 10 * 60;
const MONTHLY_CREDIT_CAP = 1800; // below the 2.000 free allowance, on purpose

const TODAY_COST = 2;
const YESTERDAY_COST = 2;
const HISTORY_COST = 4;

// Timestamp prefix per bucket. Quarter-hours keep the WHOLE timestamp (offset
// included, 25 chars) so the repeated 02:00-03:00 hour on the 25-hour day the
// clocks go back doesn't merge into one bucket.
const KEY_LENGTH = { QUARTER_HOUR: 25, DAY: 10, MONTH: 7 };

// Bump when the shape of the cached "today" changes, so a deploy refreshes
// it right away instead of serving the old shape for up to 30 minutes.
const TODAY_VERSION = 2;

const EMPTY_RANGE = {
  kpis: { productionKwh: 0, consumptionKwh: 0, selfConsumptionRate: null, purchasedKwh: 0, feedInKwh: 0 },
  chart: []
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------- Orari di lettura (ora di Roma) ----------

function romeMinutesOfDay(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(date);
  const hour = parseInt(parts.find(p => p.type === "hour").value, 10) % 24;
  const minute = parseInt(parts.find(p => p.type === "minute").value, 10);
  return hour * 60 + minute;
}

function inReadingWindow(date) {
  const weekday = isoWeekdayRome(date);
  const minutes = romeMinutesOfDay(date);
  const open = 7 * 60 + 30;
  if (weekday >= 1 && weekday <= 5) return minutes >= open && minutes <= 18 * 60 + 30;
  if (weekday === 6) return minutes >= open && minutes <= 13 * 60;
  return false;
}

// ---------- OAuth ----------

async function requestToken(body) {
  const { SOLAREDGE_CLIENT_ID, SOLAREDGE_CLIENT_SECRET } = process.env;
  if (!SOLAREDGE_CLIENT_ID || !SOLAREDGE_CLIENT_SECRET) {
    throw new Error("Missing SOLAREDGE_CLIENT_ID / SOLAREDGE_CLIENT_SECRET env vars");
  }
  const resp = await fetch(`${API_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, client_id: SOLAREDGE_CLIENT_ID, client_secret: SOLAREDGE_CLIENT_SECRET })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`SolarEdge OAuth error (${resp.status}): ${data.error || ""} ${data.error_description || ""}`.trim());
  }
  return data;
}

async function saveTokens(tokens) {
  // The old refresh token is already dead at this point, so losing the new
  // one would force a manual re-authorization — worth a few retries.
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await redis.setJson(KEY_TOKENS, tokens);
      return;
    } catch (err) {
      lastError = err;
      await sleep(300);
    }
  }
  throw lastError;
}

async function refreshTokens(current) {
  const refreshToken = (current && current.refreshToken) || process.env.SOLAREDGE_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error("No SolarEdge refresh token: set SOLAREDGE_REFRESH_TOKEN to seed the first run");
  }
  const data = await requestToken({ grant_type: "refresh_token", refresh_token: refreshToken });
  const now = Date.now();
  const tokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: now + data.expires_in * 1000,
    refreshedAt: now
  };
  await saveTokens(tokens);
  return tokens;
}

function accessTokenUsable(tokens) {
  return tokens && tokens.expiresAt - Date.now() > 2 * 60 * 1000;
}

async function getAccessToken(forceRefresh) {
  const startedAt = Date.now();
  const stored = await redis.getJson(KEY_TOKENS);
  if (!forceRefresh && accessTokenUsable(stored)) return stored.accessToken;

  if (await redis.acquireLock(KEY_TOKEN_LOCK, 30)) {
    try {
      // Another invocation may have refreshed just before we got the lock.
      const latest = await redis.getJson(KEY_TOKENS);
      if (!forceRefresh && accessTokenUsable(latest)) return latest.accessToken;
      if (forceRefresh && latest && latest.refreshedAt > startedAt) return latest.accessToken;
      return (await refreshTokens(latest)).accessToken;
    } finally {
      await redis.del(KEY_TOKEN_LOCK);
    }
  }

  // A concurrent invocation is refreshing — the refresh token is single-use,
  // so wait for its result instead of racing it.
  for (let i = 0; i < 5; i++) {
    await sleep(1500);
    const latest = await redis.getJson(KEY_TOKENS);
    if (accessTokenUsable(latest) && (!forceRefresh || latest.refreshedAt > startedAt)) {
      return latest.accessToken;
    }
  }
  throw new Error("Timed out waiting for a concurrent SolarEdge token refresh");
}

// Refresh tokens expire after 30 days unused; outside reading hours nothing
// would otherwise touch them, so renew once a week while a TV is polling.
async function keepTokensAlive() {
  const stored = await redis.getJson(KEY_TOKENS);
  if (stored && Date.now() - stored.refreshedAt > TOKEN_KEEPALIVE_MS) {
    await getAccessToken(true);
  }
}

// ---------- Chiamate API ----------

async function apiGet(path, params) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAccessToken(attempt > 0);
    const url = new URL(`${API_BASE}/sites/${process.env.SOLAREDGE_SITE_ID}/${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (resp.status === 401 && attempt === 0) continue; // token revoked/expired early: refresh once and retry

    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      throw new Error(`SolarEdge API error (${resp.status}) on ${path}: ${JSON.stringify(data)}`);
    }
    return data;
  }
}

// The V2 API wants UTC instants ("...Z", no milliseconds); answers come back
// in Rome local time with an offset, which is what the bucket keys use.
function isoZ(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------- Costruzione dei dati ----------

function addToBuckets(map, values, keyLength) {
  (values || []).forEach(v => {
    const key = v.timestamp.slice(0, keyLength);
    map.set(key, (map.get(key) || 0) + (v.value || 0));
  });
}

// Grid meter(s): importEnergy = purchased, exportEnergy = fed into the grid.
function meterBuckets(meterTelemetry, keyLength) {
  const purchased = new Map();
  const feedIn = new Map();
  Object.values((meterTelemetry && meterTelemetry.meters) || {}).forEach(meter => {
    addToBuckets(purchased, meter.importEnergy && meter.importEnergy.values, keyLength);
    addToBuckets(feedIn, meter.exportEnergy && meter.exportEnergy.values, keyLength);
  });
  return { purchased, feedIn };
}

function kwh(wh) {
  return Math.round(wh / 100) / 10; // Wh -> kWh, 1 decimal
}

function buildRange(production, purchased, feedIn, labelFn) {
  const totals = { production: 0, selfConsumption: 0, consumption: 0, purchased: 0, feedIn: 0 };

  const chart = [...production.keys()].map(key => {
    const prod = production.get(key) || 0;
    const fed = feedIn.get(key) || 0;
    const bought = purchased.get(key) || 0;
    const self = Math.max(0, prod - fed);
    const consumption = self + bought;

    totals.production += prod;
    totals.selfConsumption += self;
    totals.consumption += consumption;
    totals.purchased += bought;
    totals.feedIn += fed;

    return {
      label: labelFn(key),
      production: kwh(prod),
      consumption: kwh(consumption),
      selfConsumption: kwh(self),
      feedIn: kwh(fed),
      purchased: kwh(bought)
    };
  });

  return {
    kpis: {
      productionKwh: Math.round(totals.production / 1000),
      consumptionKwh: Math.round(totals.consumption / 1000),
      selfConsumptionRate: totals.production > 0
        ? Math.round((totals.selfConsumption / totals.production) * 100)
        : null,
      purchasedKwh: Math.round(totals.purchased / 1000),
      feedInKwh: Math.round(totals.feedIn / 1000)
    },
    chart
  };
}

// Only full hours get a tick label on the 15-minute chart.
const quarterLabel = key => (key.slice(14, 16) === "00" ? key.slice(11, 13) : "");
const dayLabel = key => `${key.slice(8, 10)}/${key.slice(5, 7)}`;
function monthLabel(key) {
  const d = new Date(`${key}-15T12:00:00Z`);
  return new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", month: "short" }).format(d);
}

// Midnight on the 1st of the Rome month that's `monthsBack` months before
// `now` (same noon-UTC trick timezone.js uses).
function monthsAgoStartRome(now, monthsBack) {
  const [year, month] = dateKeyRome(now).split("-").map(Number);
  let targetMonth = month - monthsBack;
  let targetYear = year;
  while (targetMonth <= 0) { targetMonth += 12; targetYear -= 1; }
  const noonUtc = new Date(`${targetYear}-${String(targetMonth).padStart(2, "0")}-15T12:00:00Z`);
  return startOfMonthRome(noonUtc);
}

// One day at the API's finest resolution (15 minutes): 2 calls. Inverter
// telemetry gives power AND energy together, the grid meter gives the rest.
async function fetchQuarterHourDay(fromDate, toDate) {
  const from = isoZ(fromDate);
  const to = isoZ(toDate);
  const [inverters, meters] = await Promise.all([
    apiGet("inverters/telemetry", { from, to, resolution: "QUARTER_HOUR" }),
    apiGet("meters/telemetry", { from, to, resolution: "QUARTER_HOUR" })
  ]);

  const production = new Map();
  let currentPowerW = 0;
  let sawPower = false;
  Object.values((inverters && inverters.inverters) || {}).forEach(inv => {
    addToBuckets(production, inv.energy && inv.energy.values, KEY_LENGTH.QUARTER_HOUR);
    const samples = ((inv.power && inv.power.values) || []).filter(v => v.value != null);
    if (samples.length) {
      currentPowerW += samples[samples.length - 1].value;
      sawPower = true;
    }
  });

  const { purchased, feedIn } = meterBuckets(meters, KEY_LENGTH.QUARTER_HOUR);
  return {
    production, purchased, feedIn,
    currentPowerKw: sawPower ? Math.round(currentPowerW) / 1000 : null
  };
}

async function fetchToday(now) {
  const day = await fetchQuarterHourDay(startOfDayRome(now), now);
  return {
    version: TODAY_VERSION,
    updatedAt: now.getTime(),
    dateKey: dateKeyRome(now),
    currentPowerKw: day.currentPowerKw,
    ...buildRange(day.production, day.purchased, day.feedIn, quarterLabel)
  };
}

// "Ieri" is final once the day is over, so it's fetched once per day. The
// range ends one second before midnight so today's first 15 minutes don't
// leak in as an extra bucket.
async function fetchYesterday(now) {
  const dayStart = addDaysRome(now, -1);
  const day = await fetchQuarterHourDay(dayStart, new Date(startOfDayRome(now).getTime() - 1000));
  return {
    version: TODAY_VERSION,
    updatedAt: now.getTime(),
    dateKey: dateKeyRome(dayStart),
    ...buildRange(day.production, day.purchased, day.feedIn, quarterLabel)
  };
}

// Ultimi 30 giorni + ultimi 12 mesi: 4 calls (site energy + grid meter each).
async function fetchHistory(now) {
  const to = isoZ(now);
  const last30From = isoZ(addDaysRome(now, -29));
  const monthlyFrom = isoZ(monthsAgoStartRome(now, 11));

  const [energyDay, metersDay, energyMonth, metersMonth] = await Promise.all([
    apiGet("energy", { from: last30From, to, resolution: "DAY" }),
    apiGet("meters/telemetry", { from: last30From, to, resolution: "DAY" }),
    apiGet("energy", { from: monthlyFrom, to, resolution: "MONTH" }),
    apiGet("meters/telemetry", { from: monthlyFrom, to, resolution: "MONTH" })
  ]);

  const range = (energy, meters, keyLength, labelFn) => {
    const production = new Map();
    addToBuckets(production, energy && energy.values, keyLength);
    const { purchased, feedIn } = meterBuckets(meters, keyLength);
    return buildRange(production, purchased, feedIn, labelFn);
  };

  return {
    updatedAt: now.getTime(),
    last30: range(energyDay, metersDay, KEY_LENGTH.DAY, dayLabel),
    monthly: range(energyMonth, metersMonth, KEY_LENGTH.MONTH, monthLabel)
  };
}

// ---------- Cache, budget, refresh ----------

async function withinBudget(cost, now) {
  const key = `solaredge:credits:${dateKeyRome(now).slice(0, 7)}`;
  const used = await redis.incrBy(key, cost);
  await redis.expire(key, 40 * 24 * 60 * 60);
  if (used > MONTHLY_CREDIT_CAP) {
    await redis.incrBy(key, -cost);
    console.warn(`SolarEdge credit cap (${MONTHLY_CREDIT_CAP}/month) reached — serving cached data only`);
    return false;
  }
  return true;
}

function dueParts(cache, now) {
  const inWindow = inReadingWindow(now);
  const nowMs = now.getTime();
  return {
    // With no cache at all, fetch once regardless of the hour (first run).
    today: !cache || !cache.today || cache.today.version !== TODAY_VERSION ||
      (inWindow && nowMs - cache.today.updatedAt > TODAY_TTL_MS),
    history: !cache || !cache.history || (inWindow && nowMs - cache.history.updatedAt > HISTORY_TTL_MS),
    // Due when the cached day isn't the real "yesterday" any more (a new day began).
    yesterday: !cache || !cache.yesterday || cache.yesterday.version !== TODAY_VERSION ||
      (inWindow && cache.yesterday.dateKey !== yesterdayKey(now))
  };
}

const yesterdayKey = now => dateKeyRome(addDaysRome(now, -1));

async function refreshIfDue(cache, now) {
  const due = dueParts(cache, now);
  if (!due.today && !due.history && !due.yesterday) {
    if (!inReadingWindow(now)) await keepTokensAlive();
    return cache;
  }
  if (await redis.exists(KEY_FAILURE)) return cache; // backing off after an error
  if (!(await redis.acquireLock(KEY_REFRESH_LOCK, 45))) {
    // Another invocation is already fetching. If we have nothing to show yet
    // (first load after a deploy, several TVs polling at once) wait for its
    // result instead of failing.
    for (let i = 0; !cache && i < 15; i++) {
      await sleep(1000);
      cache = await redis.getJson(KEY_CACHE);
    }
    return cache;
  }

  try {
    // Re-check: someone may have refreshed while we waited for the lock.
    const latest = (await redis.getJson(KEY_CACHE)) || cache;
    const stillDue = dueParts(latest, now);
    const cost = (stillDue.today ? TODAY_COST : 0) + (stillDue.history ? HISTORY_COST : 0) +
      (stillDue.yesterday ? YESTERDAY_COST : 0);
    if (!cost) return latest;
    if (!(await withinBudget(cost, now))) return latest;

    try {
      // At most 8 calls at once (the first request of a new day), under the
      // free tier's 10 calls/minute.
      const [today, history, yesterday] = await Promise.all([
        stillDue.today ? fetchToday(now) : null,
        stillDue.history ? fetchHistory(now) : null,
        stillDue.yesterday ? fetchYesterday(now) : null
      ]);
      const next = {
        today: today || (latest && latest.today) || null,
        history: history || (latest && latest.history) || null,
        yesterday: yesterday || (latest && latest.yesterday) || null
      };
      await redis.setJson(KEY_CACHE, next);
      return next;
    } catch (err) {
      console.error("GRAUS Fleet Kiosk solar refresh failed:", err);
      await redis.setJson(KEY_FAILURE, { at: now.toISOString(), message: err.message }, FAILURE_BACKOFF_SECONDS);
      if (!latest) throw err;
      return latest;
    }
  } finally {
    await redis.del(KEY_REFRESH_LOCK);
  }
}

function buildResponse(cache, now, stale) {
  const today = cache.today && cache.today.dateKey === dateKeyRome(now) ? cache.today : null;
  const powerFresh = today && now.getTime() - today.updatedAt < POWER_MAX_AGE_MS;
  const history = cache.history || {};
  const yesterday = cache.yesterday && cache.yesterday.dateKey === yesterdayKey(now) ? cache.yesterday : null;

  return {
    generatedAt: new Date((cache.today || cache.history || cache.yesterday).updatedAt).toISOString(),
    stale, // true while the last SolarEdge refresh failed and we're serving older data
    currentPowerKw: powerFresh ? today.currentPowerKw : null,
    ranges: {
      yesterday: yesterday ? { kpis: yesterday.kpis, chart: yesterday.chart } : EMPTY_RANGE,
      today: today ? { kpis: today.kpis, chart: today.chart } : EMPTY_RANGE,
      last30: history.last30 || EMPTY_RANGE,
      monthly: history.monthly || EMPTY_RANGE
    }
  };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    const now = new Date();
    const cache = await refreshIfDue(await redis.getJson(KEY_CACHE), now);
    if (!cache) {
      res.status(503).json({ error: "Dati fotovoltaico non ancora disponibili, riprovare tra poco" });
      return;
    }
    res.status(200).json(buildResponse(cache, now, await redis.exists(KEY_FAILURE)));
  } catch (err) {
    console.error("GRAUS Fleet Kiosk solar API error:", err);
    res.status(500).json({ error: err.message || "Unknown error" });
  }
};
