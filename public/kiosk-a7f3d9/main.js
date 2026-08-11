/*
 * GRAUS Fleet Kiosk — display logic
 *
 * Runs in a browser (Chrome kiosk mode on a mini-PC connected to a TV).
 * Fetches pre-processed fleet data from our own /api/fleet endpoint
 * (never calls Geotab directly — no credentials live in this file).
 */

const REFRESH_INTERVAL_MS = 60 * 1000;
const CENTER = [46.55, 11.9]; // Alta Badia area

let map;
let markersLayer;

function initMap() {
  map = L.map("k-map", { zoomControl: true, attributionControl: false }).setView(CENTER, 11);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    className: "k-tiles"
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
}

function fmtClock(d) {
  return d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDuration(seconds) {
  const totalMin = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function startClock() {
  const el = document.getElementById("k-clock");
  const tick = () => { el.textContent = fmtClock(new Date()); };
  tick();
  setInterval(tick, 1000);
}

function renderKpis(vehicles) {
  document.getElementById("kpi-total").textContent = vehicles.length;
  document.getElementById("kpi-moving").textContent =
    vehicles.filter(v => v.state === "moving").length;
  document.getElementById("kpi-stopped").textContent =
    vehicles.filter(v => v.state === "stopped").length;
  const totalKm = vehicles.reduce((sum, v) => sum + (v.todayDistanceKm || 0), 0);
  document.getElementById("kpi-km").textContent = Math.round(totalKm);
}

function renderMap(vehicles) {
  markersLayer.clearLayers();
  const withPosition = vehicles.filter(v => v.latitude && v.longitude);

  withPosition.forEach(v => {
    const color = v.state === "moving" ? "#4ade80"
                : v.state === "stopped" ? "#fbbf24"
                : "#64748b";
    L.circleMarker([v.latitude, v.longitude], {
      radius: 8,
      color,
      weight: 2,
      fillColor: color,
      fillOpacity: 0.85
    })
      .bindTooltip(v.name, { permanent: false, direction: "top", className: "k-marker-label" })
      .addTo(markersLayer);
  });

  if (withPosition.length) {
    const bounds = L.latLngBounds(withPosition.map(v => [v.latitude, v.longitude]));
    map.fitBounds(bounds.pad(0.25));
  }
}

function renderLeaderboard(vehicles) {
  const container = document.getElementById("k-leaderboard");
  const ranked = vehicles
    .filter(v => v.state !== "offline")
    .slice()
    .sort((a, b) => (a.todayStopSeconds || 0) - (b.todayStopSeconds || 0))
    .slice(0, 5);

  if (!ranked.length) {
    container.innerHTML = '<p class="k-empty">Nessun dato disponibile.</p>';
    return;
  }

  container.innerHTML = ranked.map((v, i) => `
    <div class="k-row ${i === 0 ? "k-row--rank1" : ""}">
      <span class="k-row-rank">${i + 1}</span>
      <span class="k-row-name">${v.name}</span>
      <span class="k-row-value">${fmtDuration(v.todayStopSeconds || 0)}</span>
    </div>
  `).join("");
}

function renderStopsList(vehicles) {
  const container = document.getElementById("k-stops");
  const sorted = vehicles
    .slice()
    .sort((a, b) => (b.todayStopSeconds || 0) - (a.todayStopSeconds || 0));

  if (!sorted.length) {
    container.innerHTML = '<p class="k-empty">Nessun dato disponibile.</p>';
    return;
  }

  container.innerHTML = sorted.map(v => `
    <div class="k-row">
      <span class="k-row-name">${v.name}</span>
      <span class="k-row-value">${fmtDuration(v.todayStopSeconds || 0)} · ${v.todayStopCount} soste</span>
    </div>
  `).join("");
}

async function refresh() {
  try {
    const resp = await fetch("/api/fleet");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    renderKpis(data.vehicles);
    renderMap(data.vehicles);
    renderLeaderboard(data.vehicles);
    renderStopsList(data.vehicles);

    document.getElementById("k-updated").textContent =
      "Aggiornato alle " + fmtClock(new Date());
  } catch (err) {
    console.error("GRAUS Fleet Kiosk — errore aggiornamento:", err);
    document.getElementById("k-updated").textContent =
      "Errore di aggiornamento — nuovo tentativo tra poco";
  }
}

startClock();
initMap();
refresh();
setInterval(refresh, REFRESH_INTERVAL_MS);
