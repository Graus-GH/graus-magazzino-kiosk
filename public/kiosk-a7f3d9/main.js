/*
 * GRAUS Fleet Kiosk — main map view
 */

const REFRESH_INTERVAL_MS = 60 * 1000;
const SPOTLIGHT_INTERVAL_MS = 15 * 1000;
const CENTER = [46.55, 11.9]; // Alta Badia area

const TILE_LAYERS = {
  voyager: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  positron: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
};

let map;
let tileLayer;
let markersByDevice = {}; // id -> Leaflet marker
let currentVehicles = [];
let spotlightIndex = 0;
let activeVehicleId = null;
let hasFitBounds = false;
let nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;

function initMap(style = "voyager") {
  map = L.map("k-map", { zoomControl: true, attributionControl: false }).setView(CENTER, 11);
  tileLayer = L.tileLayer(TILE_LAYERS[style], { maxZoom: 19 }).addTo(map);
}

function setTileStyle(style) {
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(TILE_LAYERS[style], { maxZoom: 19 }).addTo(map);

  document.getElementById("tile-voyager").classList.toggle("k-tile-btn--active", style === "voyager");
  document.getElementById("tile-positron").classList.toggle("k-tile-btn--active", style === "positron");
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

function fmtCountdown(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
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

function renderKpis(vehicles) {
  document.getElementById("kpi-total").textContent = vehicles.length;
  document.getElementById("kpi-moving").textContent =
    vehicles.filter(v => v.state === "moving").length;
  document.getElementById("kpi-stopped").textContent =
    vehicles.filter(v => v.state === "stopped").length;
  document.getElementById("kpi-offline").textContent =
    vehicles.filter(v => v.state === "offline").length;

  const totalKm = vehicles.reduce((sum, v) => sum + (v.todayDistanceKm || 0), 0);
  document.getElementById("kpi-km").textContent = Math.round(totalKm);

  const withStops = vehicles.filter(v => v.todayStopSeconds > 0);
  const avgStopSeconds = withStops.length
    ? withStops.reduce((sum, v) => sum + v.todayStopSeconds, 0) / withStops.length
    : 0;
  document.getElementById("kpi-avg-stop").textContent = fmtDuration(avgStopSeconds);
}

function statusColor(state) {
  return state === "moving" ? "#34d399" : state === "stopped" ? "#fbbf24" : "#64748b";
}

function buildMarkerIcon(v, isActive) {
  const bearing = v.bearing || 0;
  const shapeStyle = v.state === "moving" ? `style="transform:rotate(${bearing}deg);"` : "";
  const html = `
    <div class="k-marker ${isActive ? "k-marker--active" : ""}">
      <div class="k-marker-shape k-marker-shape--${v.state}" ${shapeStyle}></div>
      <span class="k-marker-name">${v.name}</span>
    </div>
  `;
  return L.divIcon({ className: "", html, iconSize: [220, 24], iconAnchor: [8, 12] });
}

function renderMap(vehicles) {
  Object.values(markersByDevice).forEach(m => map.removeLayer(m));
  markersByDevice = {};

  const withPosition = vehicles.filter(v => v.latitude && v.longitude);

  withPosition.forEach(v => {
    const marker = L.marker([v.latitude, v.longitude], {
      icon: buildMarkerIcon(v, v.id === activeVehicleId)
    }).addTo(map);
    markersByDevice[v.id] = marker;
  });

  // Fit the whole fleet in view once, on first load — never re-zoom after
  // that, so the overview stays stable while the spotlight rotates.
  if (!hasFitBounds && withPosition.length) {
    const bounds = L.latLngBounds(withPosition.map(v => [v.latitude, v.longitude]));
    map.fitBounds(bounds.pad(0.25));
    hasFitBounds = true;
  }
}

function renderRoster(vehicles) {
  const container = document.getElementById("k-roster");
  if (!vehicles.length) {
    container.innerHTML = '<p class="k-empty">Nessun veicolo trovato.</p>';
    return;
  }

  const sorted = vehicles.slice().sort((a, b) => a.name.localeCompare(b.name));

  container.innerHTML = sorted.map(v => {
    const label = v.state === "moving" ? "In movimento"
                : v.state === "stopped" ? `Fermo da ${fmtDuration((v.stopDurationMs || 0) / 1000)}`
                : "Offline";
    return `
      <div class="k-roster-row">
        <i class="k-dot k-dot--${v.state}"></i>
        <span class="k-roster-name">${v.name}</span>
        <span class="k-roster-detail">${label}</span>
      </div>
    `;
  }).join("");
}

function renderSpotlight(vehicle) {
  const body = document.getElementById("k-spotlight-body");
  if (!vehicle) {
    body.innerHTML = '<p class="k-empty">Nessun veicolo disponibile.</p>';
    return;
  }

  const statusLabel = vehicle.state === "moving" ? "In movimento"
                     : vehicle.state === "stopped" ? "Fermo"
                     : "Offline";

  body.innerHTML = `
    <div class="k-spotlight-name">${vehicle.name}</div>
    <span class="k-spotlight-status k-spotlight-status--${vehicle.state}">${statusLabel}</span>
    <div class="k-spotlight-stats">
      <div>
        <span class="k-spotlight-stat-value">${Math.round(vehicle.speed || 0)}</span>
        <span class="k-spotlight-stat-label">km/h</span>
      </div>
      <div>
        <span class="k-spotlight-stat-value">${vehicle.todayDistanceKm || 0}</span>
        <span class="k-spotlight-stat-label">km oggi</span>
      </div>
      <div>
        <span class="k-spotlight-stat-value">${fmtDuration(vehicle.todayStopSeconds || 0)}</span>
        <span class="k-spotlight-stat-label">fermo oggi</span>
      </div>
    </div>
  `;

  // Highlight this vehicle's marker — no panning or zooming, the overview
  // stays put; only the marker itself gets a brighter glow.
  activeVehicleId = vehicle.id;
  Object.entries(markersByDevice).forEach(([id, marker]) => {
    const v = currentVehicles.find(cv => String(cv.id) === id);
    if (v) marker.setIcon(buildMarkerIcon(v, id === String(vehicle.id)));
  });
}

function advanceSpotlight() {
  const withPosition = currentVehicles.filter(v => v.latitude && v.longitude);
  if (!withPosition.length) return;
  spotlightIndex = (spotlightIndex + 1) % withPosition.length;
  renderSpotlight(withPosition[spotlightIndex]);
}

async function refresh() {
  try {
    const resp = await fetch("/api/fleet");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    currentVehicles = data.vehicles;
    renderKpis(currentVehicles);
    renderMap(currentVehicles);
    renderRoster(currentVehicles);

    const withPosition = currentVehicles.filter(v => v.latitude && v.longitude);
    if (withPosition.length) {
      spotlightIndex = spotlightIndex % withPosition.length;
      renderSpotlight(withPosition[spotlightIndex]);
    }

    nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
    document.getElementById("k-updated").textContent =
      "Aggiornato alle " + fmtClock(new Date());
  } catch (err) {
    console.error("GRAUS Fleet Kiosk — errore aggiornamento:", err);
    document.getElementById("k-updated").textContent =
      "Errore di aggiornamento — nuovo tentativo tra poco";
  }
}

document.getElementById("tile-voyager").addEventListener("click", () => setTileStyle("voyager"));
document.getElementById("tile-positron").addEventListener("click", () => setTileStyle("positron"));

startClock();
initMap("voyager");
refresh();
setInterval(refresh, REFRESH_INTERVAL_MS);
setInterval(advanceSpotlight, SPOTLIGHT_INTERVAL_MS);
