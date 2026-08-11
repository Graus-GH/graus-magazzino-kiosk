/*
 * GRAUS Fleet Kiosk — Performance & Squadra view logic
 */

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const TIP_ROTATE_MS = 30 * 1000;

let nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;

const TIPS = [
  "Un minuto di motore acceso a vuoto consuma quanto 200 metri percorsi — spegnere durante le soste lunghe aiuta tutti.",
  "Pianificare le consegne per zona, quando possibile, riduce i chilometri complessivi della giornata.",
  "Un pneumatico sottogonfio di 0,5 bar può aumentare i consumi del 2-3%.",
  "Accelerazioni e frenate dolci riducono l'usura dei freni e i consumi di carburante.",
  "Controllare specchietti e angoli ciechi prima di ogni manovra in retromarcia, specialmente in cortile.",
  "Una manutenzione regolare del veicolo previene i fermi imprevisti più delle riparazioni last-minute.",
  "Segnalare per tempo un problema al mezzo evita che diventi un guasto più costoso più avanti."
];

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
  const countdownEl = document.getElementById("k-countdown");
  const tick = () => {
    el.textContent = fmtClock(new Date());
    countdownEl.textContent = "Prossimo aggiornamento tra " + fmtCountdown(nextRefreshAt - Date.now());
  };
  tick();
  setInterval(tick, 1000);
}

function startTips() {
  const el = document.getElementById("p-tip-text");
  let index = Math.floor(Math.random() * TIPS.length);
  const show = () => { el.textContent = TIPS[index]; index = (index + 1) % TIPS.length; };
  show();
  setInterval(show, TIP_ROTATE_MS);
}

function renderGoal(monthKm, monthGoalKm) {
  const pct = monthGoalKm > 0 ? Math.min(100, Math.round((monthKm / monthGoalKm) * 100)) : 0;
  document.getElementById("p-goal-bar").style.width = pct + "%";
  document.getElementById("p-goal-pct").textContent = pct + "%";
  document.getElementById("p-goal-sub").textContent =
    `${Math.round(monthKm)} / ${monthGoalKm} km`;
  document.getElementById("p-month-km").textContent = Math.round(monthKm);
}

function renderTrend(dailyKm) {
  const maxKm = Math.max(1, ...dailyKm.map(d => d.km));
  const todayKey = new Date().toISOString().slice(0, 10);

  document.getElementById("p-trend-chart").innerHTML = dailyKm.map(d => {
    const heightPct = Math.round((d.km / maxKm) * 100);
    const isToday = d.date === todayKey;
    const dayLabel = new Date(d.date + "T12:00:00").toLocaleDateString("it-IT", { weekday: "short" });
    return `
      <div class="p-trend-col">
        <span class="p-trend-value">${d.km}</span>
        <div class="p-trend-bar ${isToday ? "p-trend-bar--today" : ""}" style="height:${heightPct}%"></div>
        <span class="p-trend-day">${dayLabel}</span>
      </div>
    `;
  }).join("");
}

function renderIdling(idlingToday) {
  const container = document.getElementById("p-idling-list");
  if (!idlingToday.length) {
    container.innerHTML = '<p class="k-empty">Nessun dato disponibile.</p>';
    return;
  }

  container.innerHTML = idlingToday.map(v => `
    <div class="p-idling-row">
      <span class="p-idling-name">${v.name}</span>
      <span class="p-idling-value">${fmtDuration(v.idlingSeconds)}</span>
    </div>
  `).join("");
}

async function refresh() {
  try {
    const resp = await fetch("/api/performance");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    renderGoal(data.monthKm, data.monthGoalKm);
    renderTrend(data.dailyKm);
    renderIdling(data.idlingToday);

    nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
    document.getElementById("k-updated").textContent =
      "Aggiornato alle " + fmtClock(new Date());
  } catch (err) {
    console.error("GRAUS Fleet Kiosk (performance) — errore aggiornamento:", err);
    document.getElementById("k-updated").textContent =
      "Errore di aggiornamento — nuovo tentativo tra poco";
  }
}

startClock();
startTips();
refresh();
setInterval(refresh, REFRESH_INTERVAL_MS);
