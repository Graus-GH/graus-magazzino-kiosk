/*
 * GRAUS Fleet Kiosk — Impianto Fotovoltaico (SolarEdge)
 */

// SolarEdge's free API has a limited daily call budget per site — this
// page makes 2 calls per refresh, so keep the interval generous (15 min =
// ~192 calls/day, well under a typical ~300/day cap) rather than matching
// the fleet dashboard's 60s refresh.
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
let nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;

function fmtClock(d) {
  return d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtCountdown(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function startClock() {
  const el = document.getElementById("k-clock");
  const countdownEl = document.getElementById("k-mini-countdown");
  setInterval(() => {
    el.textContent = fmtClock(new Date());
    countdownEl.textContent = "Aggiorna tra " + fmtCountdown(nextRefreshAt - Date.now());
  }, 1000);
  el.textContent = fmtClock(new Date());
}

function renderKpis(data) {
  document.getElementById("sol-power").textContent =
    data.currentPowerKw != null ? data.currentPowerKw.toFixed(1) + " kW" : "n/d";
  document.getElementById("sol-today").textContent =
    data.todayEnergyKwh != null ? Math.round(data.todayEnergyKwh) + " kWh" : "n/d";
  document.getElementById("sol-month").textContent =
    data.monthEnergyKwh != null ? Math.round(data.monthEnergyKwh) + " kWh" : "n/d";
  document.getElementById("sol-year").textContent =
    data.yearEnergyKwh != null ? Math.round(data.yearEnergyKwh) + " kWh" : "n/d";
}

function renderChart(chart) {
  const maxKw = Math.max(1, ...chart.map(c => c.kw));
  document.getElementById("sol-chart").innerHTML = chart.map(c => `
    <div class="sol-chart-col">
      <span class="sol-chart-value">${c.kw > 0 ? c.kw.toFixed(1) : ""}</span>
      <div class="sol-chart-bar" style="height:${Math.round((c.kw / maxKw) * 100)}%"></div>
      <span class="sol-chart-hour">${c.label}</span>
    </div>
  `).join("");
}

async function refresh() {
  try {
    const resp = await fetch("/api/solar");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    renderKpis(data);
    renderChart(data.chart);

    nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
  } catch (err) {
    console.error("GRAUS Fleet Kiosk (solare) — errore aggiornamento:", err);
  }
}

startClock();
refresh();
setInterval(refresh, REFRESH_INTERVAL_MS);
