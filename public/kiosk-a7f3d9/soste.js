/*
 * GRAUS Fleet Kiosk — Analisi Soste view logic
 */

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // heavier endpoint — refresh less often
const HOME_ZONE_MATCH = "graus"; // case-insensitive substring match on zone name
const LONG_STOP_SECONDS = 30 * 60; // flag stops at 30+ min away from base — adjust freely

let nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
let refreshTimer = null;
let selectedDate = null; // null = today

function todayKey() {
  // Local (browser) date — the kiosk's own clock/timezone, which is Italy
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function fmtClock(d) {
  return d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(seconds) {
  const totalMin = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtCountdown(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function startClock() {
  const el = document.getElementById("k-clock");
  setInterval(() => { el.textContent = fmtClock(new Date()); }, 1000);
  el.textContent = fmtClock(new Date());
}

function statusLabel(state) {
  return state === "moving" ? "In movimento" : state === "stopped" ? "Fermo" : "Offline";
}

function locationHtml(s) {
  const isHome = s.zoneName && s.zoneName.toLowerCase().includes(HOME_ZONE_MATCH);

  if (isHome) {
    return `<span class="s-zone-badge s-zone-badge--home">🏠 ${s.zoneName}</span>`;
  }
  if (s.zoneName) {
    return `<span class="s-zone-badge">${s.zoneName}</span>`;
  }
  if (s.address) {
    return `<span class="s-stop-address">${s.address}</span> <a href="${s.mapUrl}" target="_blank" rel="noopener">mappa</a>`;
  }
  return `<a href="${s.mapUrl}" target="_blank" rel="noopener">${s.lat}, ${s.lng}</a>`;
}

function renderVehicles(vehicles) {
  const container = document.getElementById("s-vehicles");

  if (!vehicles.length) {
    container.innerHTML = '<p class="k-empty">Nessun veicolo trovato.</p>';
    return;
  }

  container.innerHTML = vehicles.map(v => `
    <div class="s-vehicle-card">
      <div class="s-vehicle-header">
        <span class="s-vehicle-name">${v.name}</span>
        <span class="s-vehicle-total">${fmtDuration(v.totalStopSeconds)}</span>
      </div>
      <div class="s-vehicle-sub">
        <span class="k-spotlight-status k-spotlight-status--${v.state}">${statusLabel(v.state)}</span>
        <span>${v.stopCount} sost${v.stopCount === 1 ? "a" : "e"}</span>
      </div>
      <div class="s-stop-list">
        ${v.stops.length ? v.stops.map(s => {
          const isHome = s.zoneName && s.zoneName.toLowerCase().includes(HOME_ZONE_MATCH);
          const isLong = !isHome && s.durationSeconds >= LONG_STOP_SECONDS;
          const endLabel = s.ongoing ? "in corso" : fmtTime(s.end);
          return `
            <div class="s-stop ${s.ongoing ? "s-stop--ongoing" : ""} ${isLong ? "s-stop--long" : ""}">
              <div class="s-stop-top">
                <span class="s-stop-time">${fmtTime(s.start)} → ${endLabel}</span>
                <span>
                  <span class="s-stop-duration">${fmtDuration(s.durationSeconds)}</span>
                  ${isLong ? '<span class="s-stop-flag">Sosta lunga</span>' : ""}
                </span>
              </div>
              <div class="s-stop-location">${locationHtml(s)}</div>
            </div>
          `;
        }).join("") : '<p class="k-empty">Nessuna sosta rilevata.</p>'}
      </div>
    </div>
  `).join("");
}

async function refresh() {
  try {
    const url = selectedDate ? `/api/stops?date=${selectedDate}` : "/api/stops";
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    renderVehicles(data.vehicles);
  } catch (err) {
    console.error("GRAUS Fleet Kiosk (soste) — errore aggiornamento:", err);
  }
}

function setDate(dateStr) {
  selectedDate = (dateStr === todayKey()) ? null : dateStr;

  if (refreshTimer) clearInterval(refreshTimer);
  if (!selectedDate) {
    refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
  }

  refresh();
}

function initDatePicker() {
  const input = document.getElementById("s-date-picker");
  input.max = todayKey();
  input.value = todayKey();
  input.addEventListener("change", () => setDate(input.value));
}

startClock();
initDatePicker();
refresh();
refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
