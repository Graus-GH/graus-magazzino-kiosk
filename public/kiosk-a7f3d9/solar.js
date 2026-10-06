/*
 * GRAUS Fleet Kiosk — Impianto Fotovoltaico (SolarEdge)
 */

// /api/solar serves a cached copy and only talks to SolarEdge itself on its
// own schedule (see api/solar.js), so polling it often costs no SolarEdge
// credits — this just keeps the TV close to the server's latest data.
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const ROTATE_INTERVAL_MS = 30 * 1000; // no one can click on a TV — rotate views automatically
const RESUME_AFTER_MANUAL_MS = 90 * 1000; // roughly one full 3-view cycle

const RANGE_KEYS = ["today", "last30", "monthly"];
const RANGE_TITLES = {
  today: "Oggi — ogni 15 minuti",
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

// Italian convention: "." for thousands, "," for decimals (e.g. 1.234,5),
// instead of JS's default en-US-shaped stringification.
function fmtNum(n, decimals = 0) {
  return n.toLocaleString("it-IT", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
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

// Restarts the ring's fill animation from empty over `durationMs` — called
// each time a new auto-rotation cycle begins. Same little wheel used for
// the vehicle spotlight on the map dashboard and Performance's tabs,
// driving an SVG circle's stroke-dashoffset instead of a bar's width.
function startRotateProgress(elId, durationMs) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.classList.remove("k-rotate-ring-fg--animating");
  el.style.animationDuration = durationMs + "ms";
  void el.getBBox(); // force reflow (SVG equivalent of offsetWidth) so the animation restarts from empty
  el.classList.add("k-rotate-ring-fg--animating");
}

// Stops the ring and empties it — used while rotation is paused (e.g.
// after a manual click), so it doesn't keep animating a cycle that isn't
// actually happening.
function stopRotateProgress(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.classList.remove("k-rotate-ring-fg--animating");
  el.style.strokeDashoffset = "94.2";
}

// A thin bar split in the chart's colors: segments = [[kind, value], ...],
// widths proportional to value; whatever is left of the bar stays as track.
function renderKpiBar(id, segments, total) {
  document.getElementById(id).innerHTML = total > 0
    ? segments.map(([kind, value]) =>
        `<i class="sol-kpi-seg sol-kpi-seg--${kind}" style="width:${Math.min(100, (value / total) * 100)}%"></i>`
      ).join("")
    : "";
}

function renderKpiSplit(id, parts) {
  document.getElementById(id).innerHTML = parts.map(([kind, text]) =>
    `<span><i class="sol-flow-dot sol-flow-dot--${kind}"></i>${text}</span>`
  ).join("");
}

function renderKpis(kpis) {
  const produced = kpis.productionKwh;
  const consumed = kpis.consumptionKwh;
  const fedIn = kpis.feedInKwh;
  const bought = kpis.purchasedKwh;
  const self = Math.max(0, produced - fedIn);

  document.getElementById("sol-produced").textContent = fmtNum(produced) + " kWh";
  document.getElementById("sol-consumed").textContent = fmtNum(consumed) + " kWh";
  document.getElementById("sol-selfcons").textContent =
    kpis.selfConsumptionRate != null ? kpis.selfConsumptionRate + "%" : "n/d";
  document.getElementById("sol-grid").textContent = fmtNum(bought) + " kWh";

  renderKpiBar("sol-produced-bar", [["self", self], ["feedin", fedIn]], produced);
  renderKpiSplit("sol-produced-split", [["self", fmtNum(self) + " usata"], ["feedin", fmtNum(fedIn) + " immessa"]]);

  renderKpiBar("sol-consumed-bar", [["self", Math.max(0, consumed - bought)], ["purchased", bought]], consumed);
  renderKpiSplit("sol-consumed-split", [["self", fmtNum(Math.max(0, consumed - bought)) + " dal sole"], ["purchased", fmtNum(bought) + " dalla rete"]]);

  renderKpiBar("sol-selfcons-bar", [["self", kpis.selfConsumptionRate || 0]], 100);
  renderKpiSplit("sol-selfcons-split", [["self", "dell'energia prodotta"]]);

  const gridShare = consumed > 0 ? Math.round((bought / consumed) * 100) : null;
  renderKpiBar("sol-grid-bar", [["purchased", bought]], consumed);
  renderKpiSplit("sol-grid-split", [["purchased", gridShare != null ? gridShare + "% dei consumi" : "n/d"]]);
}

// The "Produzione / Consumo" captions are vertical text that needs ~110px per
// half; on a very short chart they'd be cut mid-word, so hide them there
// (visibility keeps the gutter, so the bars don't shift).
function updateAxisVisibility() {
  const axis = document.querySelector(".sol-flow-axis");
  if (axis) axis.classList.toggle("sol-flow-axis--hidden", axis.clientHeight < 240);
}
window.addEventListener("resize", updateAxisVisibility);

function renderChart(chart) {
  const maxVal = Math.max(1, ...chart.map(c => Math.max(c.production, c.consumption)));

  const chartEl = document.getElementById("sol-chart");
  chartEl.classList.toggle("sol-flow-chart--dense", chart.length > 40); // the 15-minute view
  requestAnimationFrame(updateAxisVisibility);

  chartEl.innerHTML = chart.map(c => `
    <div class="sol-flow-col">
      <div class="sol-flow-up">
        <div class="sol-flow-bar sol-flow-bar--self" style="height:${(c.selfConsumption / maxVal) * 100}%"></div>
        <div class="sol-flow-bar sol-flow-bar--feedin" style="height:${(c.feedIn / maxVal) * 100}%"></div>
      </div>
      <div class="sol-flow-mid"></div>
      <div class="sol-flow-down">
        <div class="sol-flow-bar sol-flow-bar--self" style="height:${(c.selfConsumption / maxVal) * 100}%"></div>
        <div class="sol-flow-bar sol-flow-bar--purchased" style="height:${(c.purchased / maxVal) * 100}%"></div>
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
  startRotateProgress("sol-rotate-ring", ROTATE_INTERVAL_MS);
}

function startRotation() {
  if (rotateTimer) clearInterval(rotateTimer);
  rotateTimer = setInterval(advanceRange, ROTATE_INTERVAL_MS);
  startRotateProgress("sol-rotate-ring", ROTATE_INTERVAL_MS);
}

function selectRangeManually(index) {
  showRange(index);
  if (rotateTimer) clearInterval(rotateTimer);
  if (resumeTimer) clearTimeout(resumeTimer);
  stopRotateProgress("sol-rotate-ring");
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
      data.currentPowerKw != null ? fmtNum(data.currentPowerKw, 1) + " kW" : "n/d";
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
