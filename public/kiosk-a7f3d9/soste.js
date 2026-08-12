/*
 * GRAUS Fleet Kiosk — Analisi Soste view logic
 */

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // heavier endpoint — refresh less often
const HOME_ZONE_MATCH = "graus"; // case-insensitive substring match on zone name
const LONG_STOP_SECONDS = 30 * 60; // flag stops at 30+ min away from base — adjust freely

let refreshTimer = null;
let selectedDate = null; // null = today
let nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;

const openMapIds = new Set(); // vehicle ids whose mini-map is currently expanded
const mapInstances = {};      // vehicle id -> Leaflet map instance

// Driver names only load if the URL has ?key=... matching DRIVER_REVEAL_KEY
// on the server. Nobody sees this on the normal kiosk URL.
const driverKey = new URLSearchParams(window.location.search).get("key");

function todayKey() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
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

function startCountdown() {
  const el = document.getElementById("k-mini-countdown");
  setInterval(() => {
    el.textContent = selectedDate
      ? "Vista storica — nessun aggiornamento"
      : "Aggiorna tra " + fmtCountdown(nextRefreshAt - Date.now());
  }, 1000);
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

  // Tear down any live map instances before the DOM they live in is replaced
  Object.values(mapInstances).forEach(m => m.remove());
  for (const k in mapInstances) delete mapInstances[k];

  if (!vehicles.length) {
    container.innerHTML = '<p class="k-empty">Nessun veicolo trovato.</p>';
    return;
  }

  container.innerHTML = vehicles.map(v => {
    const hasPosition = v.latitude && v.longitude;
    const isOpen = openMapIds.has(v.id);
    return `
    <div class="s-vehicle-card">
      <div class="s-vehicle-header">
        <span class="s-vehicle-name">${v.name}${v.driverName ? `<span class="s-driver-name"> — ${v.driverName}</span>` : ""}</span>
        <span class="s-vehicle-total">${fmtDuration(v.totalStopSeconds)}</span>
      </div>
      <div class="s-vehicle-sub">
        <span class="k-spotlight-status k-spotlight-status--${v.state}">${statusLabel(v.state)}</span>
        <span>${v.stopCount} sost${v.stopCount === 1 ? "a" : "e"}</span>
        <span>${v.distanceKm} km</span>
        <span>${fmtDuration(v.drivingSeconds)} motore</span>
        ${hasPosition ? `<button class="s-map-toggle" data-vehicle="${v.id}">${isOpen ? "📍 Nascondi mappa" : "📍 Mostra mappa"}</button>` : ""}
      </div>
      ${hasPosition ? `<div class="s-vehicle-map" id="s-map-${v.id}" style="display:${isOpen ? "block" : "none"}"></div>` : ""}
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
  `;
  }).join("");

  // Wire up the toggle buttons and re-open any maps that were open before this refresh
  vehicles.forEach(v => {
    const btn = container.querySelector(`.s-map-toggle[data-vehicle="${v.id}"]`);
    if (btn) btn.addEventListener("click", () => toggleVehicleMap(v));
    if (v.latitude && v.longitude && openMapIds.has(v.id)) {
      initVehicleMap(v);
    }
  });
}

function initVehicleMap(v) {
  if (mapInstances[v.id]) return;
  const el = document.getElementById("s-map-" + v.id);
  if (!el) return;
  const map = L.map(el, { zoomControl: true, attributionControl: true })
    .setView([v.latitude, v.longitude], 15);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap"
  }).addTo(map);
  L.marker([v.latitude, v.longitude]).addTo(map).bindPopup(v.name);
  mapInstances[v.id] = map;
}

function toggleVehicleMap(v) {
  const el = document.getElementById("s-map-" + v.id);
  const btn = document.querySelector(`.s-map-toggle[data-vehicle="${v.id}"]`);
  const isOpen = openMapIds.has(v.id);

  if (isOpen) {
    openMapIds.delete(v.id);
    el.style.display = "none";
    if (mapInstances[v.id]) { mapInstances[v.id].remove(); delete mapInstances[v.id]; }
    if (btn) btn.textContent = "📍 Mostra mappa";
  } else {
    openMapIds.add(v.id);
    el.style.display = "block";
    if (btn) btn.textContent = "📍 Nascondi mappa";
    initVehicleMap(v);
  }
}

async function refresh() {
  try {
    const params = new URLSearchParams();
    if (selectedDate) params.set("date", selectedDate);
    if (driverKey) params.set("key", driverKey);
    const qs = params.toString();
    const resp = await fetch("/api/stops" + (qs ? "?" + qs : ""));
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    renderVehicles(data.vehicles);
    nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
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

initDatePicker();
startCountdown();
refresh();
refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
