/*
 * GRAUS Fleet Kiosk — Impianto Fotovoltaico (SolarEdge)
 */

// SolarEdge's free API has a limited daily call budget per site — this
// page makes 4 calls per refresh (overview + 3 energyDetails ranges), so
// the interval is longer than the fleet dashboard's 60s: ~20 min = ~288
// calls/day, comfortably under a typical ~300/day cap.
const REFRESH_INTERVAL_MS = 20 * 60 * 1000;
const ROTATE_INTERVAL_MS = 30 * 1000; // no one can click on a TV — rotate views automatically
const RESUME_AFTER_MANUAL_MS = 90 * 1000; // roughly one full 3-view cycle

const RANGE_KEYS = ["today", "last30", "monthly"];
const RANGE_TITLES = {
  today: "Oggi — andamento orario",
  last30: "Ultimi 30 giorni",
  monthly: "Ultimi 12 mesi"
};

let nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
let latestData = null;
let currentRangeIndex = 0;
let rotateTimer = null;
let resumeTimer = null;

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

// Restarts the blue countdown bar's fill animation from 0% over
// `durationMs` — called each time a new auto-rotation cycle begins.
function startRotateProgress(elId, durationMs) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.classList.remove("k-rotate-progress-fill--animating");
  el.style.animationDuration = durationMs + "ms";
  void el.offsetWidth; // force reflow so the animation restarts from 0%
  el.classList.add("k-rotate-progress-fill--animating");
}

// Stops the bar and empties it — used while rotation is paused (e.g. after
// a manual click), so it doesn't keep animating a cycle that isn't
// actually happening.
function stopRotateProgress(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.classList.remove("k-rotate-progress-fill--animating");
  el.style.width = "0%";
}

function renderKpis(kpis) {
  document.getElementById("sol-produced").textContent = kpis.productionKwh + " kWh";
  document.getElementById("sol-consumed").textContent = kpis.consumptionKwh + " kWh";
  document.getElementById("sol-selfcons").textContent =
    kpis.selfConsumptionRate != null ? kpis.selfConsumptionRate + "%" : "n/d";
  document.getElementById("sol-grid").textContent = kpis.purchasedKwh + " kWh";
}

function renderChart(chart) {
  const maxVal = Math.max(1, ...chart.map(c => Math.max(c.production, c.consumption)));

  document.getElementById("sol-chart").innerHTML = chart.map(c => `
    <div class="sol-flow-col">
      <div class="sol-flow-up">
        <div class="sol-flow-bar sol-flow-bar--selfcons-up" style="height:${Math.round((c.selfConsumption / maxVal) * 100)}%"></div>
        <div class="sol-flow-bar sol-flow-bar--feedin" style="height:${Math.round((c.feedIn / maxVal) * 100)}%"></div>
      </div>
      <div class="sol-flow-mid"></div>
      <div class="sol-flow-down">
        <div class="sol-flow-bar sol-flow-bar--selfcons-down" style="height:${Math.round((c.selfConsumption / maxVal) * 100)}%"></div>
        <div class="sol-flow-bar sol-flow-bar--purchased" style="height:${Math.round((c.purchased / maxVal) * 100)}%"></div>
      </div>
      <span class="sol-flow-label">${c.label}</span>
    </div>
  `).join("");
}

function showRange(index) {
  currentRangeIndex = index;
  const key = RANGE_KEYS[index];

  document.querySelectorAll(".sol-range-tab").forEach(b =>
    b.classList.toggle("sol-range-tab--active", b.dataset.range === key)
  );
  document.getElementById("sol-chart-title").textContent = RANGE_TITLES[key];

  if (!latestData) return;
  renderKpis(latestData.ranges[key].kpis);
  renderChart(latestData.ranges[key].chart);
}

function advanceRange() {
  showRange((currentRangeIndex + 1) % RANGE_KEYS.length);
  startRotateProgress("sol-rotate-fill", ROTATE_INTERVAL_MS);
}

function startRotation() {
  if (rotateTimer) clearInterval(rotateTimer);
  rotateTimer = setInterval(advanceRange, ROTATE_INTERVAL_MS);
  startRotateProgress("sol-rotate-fill", ROTATE_INTERVAL_MS);
}

function selectRangeManually(index) {
  showRange(index);
  if (rotateTimer) clearInterval(rotateTimer);
  if (resumeTimer) clearTimeout(resumeTimer);
  stopRotateProgress("sol-rotate-fill");
  resumeTimer = setTimeout(startRotation, RESUME_AFTER_MANUAL_MS);
}

function initRangeTabs() {
  document.querySelectorAll(".sol-range-tab").forEach((btn, i) => {
    btn.addEventListener("click", () => selectRangeManually(i));
  });
}

async function refresh() {
  try {
    const resp = await fetch("/api/solar");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    latestData = data;
    document.getElementById("sol-power-live").textContent =
      data.currentPowerKw != null ? data.currentPowerKw.toFixed(1) + " kW" : "n/d";
    showRange(currentRangeIndex);

    nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
  } catch (err) {
    console.error("GRAUS Fleet Kiosk (solare) — errore aggiornamento:", err);
  }
}

startClock();
initRangeTabs();
refresh();
setInterval(refresh, REFRESH_INTERVAL_MS);
startRotation();
