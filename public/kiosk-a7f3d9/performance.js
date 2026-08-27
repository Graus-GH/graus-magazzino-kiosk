/*
 * GRAUS Fleet Kiosk — Performance & Squadra view logic
 */

const REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const TIP_ROTATE_MS = 30 * 1000;
// Nobody clicks Settimana/Mese/Anno on a TV, so — same idea as
// Fotovoltaico's Oggi/30gg/12mesi — the three views rotate on their own;
// still manually clickable (e.g. from an office PC), which pauses rotation
// and resumes it after roughly one full cycle.
const ROTATE_INTERVAL_MS = 30 * 1000;
const RESUME_AFTER_MANUAL_MS = 90 * 1000;
const RANGE_KEYS = ["week", "month", "year"];

let currentRange = "week";
let nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
let rotateTimer = null;
let resumeTimer = null;

const driverKey = new URLSearchParams(window.location.search).get("key");

const TIPS = [
  "Un minuto di motore acceso a vuoto consuma quanto 200 metri percorsi — spegnere durante le soste lunghe aiuta tutti.",
  "Pianificare le consegne per zona, quando possibile, riduce i chilometri complessivi della giornata.",
  "Un pneumatico sottogonfio di 0,5 bar può aumentare i consumi del 2-3%.",
  "Accelerazioni e frenate dolci riducono l'usura dei freni e i consumi di carburante.",
  "Controllare specchietti e angoli ciechi prima di ogni manovra in retromarcia, specialmente in cortile.",
  "Una manutenzione regolare del veicolo previene i fermi imprevisti più delle riparazioni last-minute.",
  "Segnalare per tempo un problema al mezzo evita che diventi un guasto più costoso più avanti."
];

const RANGE_TITLES = {
  week: "Andamento — ultimi 7 giorni",
  month: "Andamento — questo mese",
  year: "Andamento — ultimi 12 mesi"
};

function fmtClock(d) {
  return d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtCountdown(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function fmtDuration(seconds) {
  const totalMin = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
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

function startTips() {
  const el = document.getElementById("p-tip-text");
  let index = Math.floor(Math.random() * TIPS.length);
  const show = () => { el.textContent = TIPS[index]; index = (index + 1) % TIPS.length; };
  show();
  setInterval(show, TIP_ROTATE_MS);
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

function renderKpis(totals) {
  document.getElementById("p-total-km").textContent = totals.km;
  document.getElementById("p-avg-km").textContent = totals.avgKmPerDay;
  document.getElementById("p-driving-hours").textContent = fmtDuration(totals.drivingHoursSeconds);
  document.getElementById("p-idling-hours").textContent = fmtDuration(totals.idlingHoursSeconds);
}

function renderTrend(chart) {
  document.getElementById("p-trend-title").textContent = RANGE_TITLES[currentRange];

  const maxKm = Math.max(1, ...chart.map(c => c.km));
  const todayIndex = currentRange === "week" ? chart.length - 1 : -1;

  document.getElementById("p-trend-chart").innerHTML = chart.map((c, i) => {
    const heightPct = Math.round((c.km / maxKm) * 100);
    const isToday = i === todayIndex;
    return `
      <div class="p-trend-col">
        <span class="p-trend-value">${c.km}</span>
        <div class="p-trend-bar ${isToday ? "p-trend-bar--today" : ""}" style="height:${heightPct}%"></div>
        <span class="p-trend-day">${c.label}</span>
      </div>
    `;
  }).join("");
}

function renderRanking(kmPerVehicle) {
  const container = document.getElementById("p-ranking-chart");
  if (!kmPerVehicle.length) {
    container.innerHTML = '<p class="k-empty">Nessun dato disponibile.</p>';
    return;
  }
  const maxKm = Math.max(1, ...kmPerVehicle.map(v => v.km));

  container.innerHTML = kmPerVehicle.map(v => `
    <div class="p-ranking-row">
      <span class="p-ranking-name">${v.name}${v.driverName ? `<span class="s-driver-badge">${v.driverName}</span>` : ""}</span>
      <div class="p-ranking-track"><div class="p-ranking-fill" style="width:${Math.round((v.km / maxKm) * 100)}%"></div></div>
      <span class="p-ranking-value">${v.km} km</span>
    </div>
  `).join("");
}

function renderIdling(idling) {
  const container = document.getElementById("p-idling-list");
  if (!idling.length) {
    container.innerHTML = '<p class="k-empty">Nessun dato disponibile.</p>';
    return;
  }
  container.innerHTML = idling.map(v => `
    <div class="p-idling-row">
      <span class="p-row-name">${v.name}${v.driverName ? `<span class="s-driver-badge">${v.driverName}</span>` : ""}</span>
      <span class="p-row-detail">${fmtDuration(v.idlingSeconds)}</span>
    </div>
  `).join("");
}

function renderSpeeding(speeding, available, ruleName) {
  const sub = document.getElementById("p-speeding-sub");
  const container = document.getElementById("p-speeding-list");

  if (!available) {
    sub.textContent = `Regola "${ruleName}" non trovata in Geotab`;
    container.innerHTML = '<p class="k-empty">Verifica che la regola sia attiva in MyGeotab (Amministrazione → Regole e Gruppi).</p>';
    return;
  }

  sub.textContent = "Attivato quando si supera il limite stradale di almeno il 20% per 5+ secondi (regola Geotab)";

  if (!speeding.length) {
    container.innerHTML = '<p class="k-empty">Nessun dato disponibile.</p>';
    return;
  }
  container.innerHTML = speeding.map(v => `
    <div class="p-speeding-row ${v.eventCount > 0 ? "p-speeding-row--flagged" : ""}">
      <span class="p-row-name">${v.name}${v.driverName ? `<span class="s-driver-badge">${v.driverName}</span>` : ""}</span>
      <span class="p-row-detail">${v.eventCount > 0 ? `${v.eventCount} event${v.eventCount === 1 ? "o" : "i"} · ${fmtDuration(v.totalDurationSeconds)}` : "Nessun eccesso"}</span>
    </div>
  `).join("");
}

async function refresh() {
  try {
    const resp = await fetch("/api/performance?range=" + currentRange + (driverKey ? "&key=" + encodeURIComponent(driverKey) : ""));
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    renderKpis(data.totals);
    renderTrend(data.chart);
    renderRanking(data.kmPerVehicle);
    renderIdling(data.idling);
    renderSpeeding(data.speeding, data.speedingAvailable, data.speedingRuleName);

    nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
  } catch (err) {
    console.error("GRAUS Fleet Kiosk (performance) — errore aggiornamento:", err);
  }
}

function showRange(key) {
  currentRange = key;
  document.querySelectorAll(".p-range-tab").forEach(b => b.classList.toggle("p-range-tab--active", b.dataset.range === key));
  refresh();
}

function advanceRange() {
  showRange(RANGE_KEYS[(RANGE_KEYS.indexOf(currentRange) + 1) % RANGE_KEYS.length]);
  startRotateProgress("p-rotate-fill", ROTATE_INTERVAL_MS);
}

function startRotation() {
  if (rotateTimer) clearInterval(rotateTimer);
  rotateTimer = setInterval(advanceRange, ROTATE_INTERVAL_MS);
  startRotateProgress("p-rotate-fill", ROTATE_INTERVAL_MS);
}

function selectRangeManually(key) {
  showRange(key);
  if (rotateTimer) clearInterval(rotateTimer);
  if (resumeTimer) clearTimeout(resumeTimer);
  stopRotateProgress("p-rotate-fill");
  resumeTimer = setTimeout(startRotation, RESUME_AFTER_MANUAL_MS);
}

function initRangeTabs() {
  document.querySelectorAll(".p-range-tab").forEach(btn => {
    btn.addEventListener("click", () => selectRangeManually(btn.dataset.range));
  });
}

startClock();
startTips();
initRangeTabs();
refresh();
setInterval(refresh, REFRESH_INTERVAL_MS);
startRotation();
