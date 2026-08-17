/*
 * GRAUS Fleet Kiosk — main map view
 */

// Forces Leaflet to position tiles with plain CSS left/top instead of
// transform3d/GPU compositing. The TV's browser engine was rendering the
// map with alternating blank horizontal bands — a known failure mode for
// transform3d tile positioning on older/embedded Chromium builds — even
// though the map's own measured size was correct. 2D positioning is a
// little less smooth when panning, which doesn't matter here since this
// kiosk isn't interactive and just redraws on each periodic refresh.
if (window.L) L.Browser.any3d = false;

const REFRESH_INTERVAL_MS = 60 * 1000;
const SPOTLIGHT_INTERVAL_MS = 15 * 1000;
const CENTER = [46.55, 11.9]; // Alta Badia area

// Driver names only load if the URL has ?key=... matching DRIVER_REVEAL_KEY
// on the server. Nobody sees this on the normal kiosk URL.
const driverKey = new URLSearchParams(window.location.search).get("key");

// GRAUS bonades ZIJA — home base, taken from real stop coordinates already
// seen in the Analisi Soste zone matches. Verify/adjust if not precise.
const HOME_BASE = { lat: 46.6305, lng: 11.8956 };
const HOME_BASE_RADIUS_M = 300; // within this distance, just say "In sede"
const HOME_ZONE_MATCH = "graus"; // case-insensitive substring match on zone name, same as Analisi Soste

const TILE_LAYERS = {
  voyager: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  osm: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
};

// The spotlight/detail mini-map always uses standard OpenStreetMap tiles —
// independent from whatever style is chosen for the main overview map —
// because they show the richest set of labeled points of interest
// (restaurants, hotels, shops) at close zoom, which is the whole point of
// that close-up view.
const SPOTLIGHT_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const SPOTLIGHT_SATELLITE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const SPOTLIGHT_ZOOM = 16;

let map;
let tileLayer;
let markersByDevice = {}; // id -> Leaflet marker
let currentVehicles = [];
let spotlightIndex = 0;
let activeVehicleId = null;
let nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
let spotlightMap;
let spotlightTileLayer;
let spotlightIsSatellite = false;
let spotlightMarker;
let spotlightTimer = null;
let resumeTimer = null;

function createTileLayer(style) {
  return L.tileLayer(TILE_LAYERS[style], { maxZoom: 19 });
}

function initMap(style = "voyager") {
  map = L.map("k-map", { zoomControl: true, attributionControl: false }).setView(CENTER, 11);
  tileLayer = createTileLayer(style).addTo(map);
  map.on("zoomend moveend", declutterLabels);

  // Leaflet measures its container once at creation time and only loads
  // tiles for that size — if the surrounding layout still settles after
  // that (web fonts loading async and reflowing the KPI row's height is
  // the usual culprit, especially on a TV that's slower to finish
  // rendering), the map is left showing tiles only for its stale initial
  // size, with the rest blank until told to re-measure.
  const refreshMapSize = () => {
    if (!map) return;
    map.invalidateSize();
    if (tileLayer) tileLayer.redraw();
  };
  setTimeout(refreshMapSize, 300);
  setTimeout(refreshMapSize, 1200);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(refreshMapSize);
  }
  window.addEventListener("resize", refreshMapSize);
}

// Hides overlapping vehicle-name labels (keeping the colored shape always
// visible) by checking real on-screen bounding-box collisions — no plugin,
// just on-screen bounding-box math.
function declutterLabels() {
  if (!map) return;

  // Deterministic, DOM-timing-independent approach: compute each marker's
  // on-screen point directly from the map's current projection (pure
  // math, always correct immediately) instead of measuring rendered label
  // elements via getBoundingClientRect — that depended on the browser
  // having finished layout/animation at the exact moment we checked, which
  // proved unreliable. Width is ESTIMATED from each label's own text length
  // (not a flat constant) rather than measured, since labels vary a lot in
  // length — much more so once a driver name is appended (?key=... reveal)
  // — and a fixed width either misses real overlaps for long labels or
  // hides short ones unnecessarily.
  const CHAR_WIDTH_PX = 7.2; // rough average glyph width for the label's font/size
  const LABEL_PADDING_PX = 22; // the label pill's own left+right padding
  const LABEL_HEIGHT_PX = 26;

  const entries = Object.entries(markersByDevice).map(([id, marker]) => ({
    id,
    marker,
    point: map.latLngToContainerPoint(marker.getLatLng())
  }));

  // The active/spotlighted vehicle's label always wins any collision
  entries.sort((a, b) => (a.id === String(activeVehicleId) ? -1 : b.id === String(activeVehicleId) ? 1 : 0));

  const shown = [];
  entries.forEach(({ marker, point }) => {
    const el = marker.getElement();
    if (!el) return;
    const nameEl = el.querySelector(".k-marker-name");
    if (!nameEl) return;

    const width = nameEl.textContent.length * CHAR_WIDTH_PX + LABEL_PADDING_PX;

    const overlaps = shown.some(s =>
      Math.abs(s.point.x - point.x) < (s.width + width) / 2 && Math.abs(s.point.y - point.y) < LABEL_HEIGHT_PX
    );

    if (overlaps) {
      nameEl.style.display = "none";
    } else {
      nameEl.style.display = "";
      shown.push({ point, width });
    }
  });
}

function initSpotlightMap() {
  spotlightMap = L.map("k-spotlight-map", {
    zoomControl: true,
    attributionControl: true,
    dragging: true,
    scrollWheelZoom: true,
    doubleClickZoom: true,
    touchZoom: true
  }).setView(CENTER, SPOTLIGHT_ZOOM);
  spotlightTileLayer = L.tileLayer(SPOTLIGHT_TILE_URL, {
    maxZoom: 19,
    attribution: "© OpenStreetMap"
  }).addTo(spotlightMap);

  // Manual interaction with the detail map pauses the auto-rotation too,
  // same courtesy as clicking a vehicle in the roster.
  spotlightMap.on("dragstart zoomstart", () => {
    if (spotlightTimer) clearInterval(spotlightTimer);
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(startSpotlightRotation, 30 * 1000);
  });

  document.getElementById("k-spotlight-expand").addEventListener("click", () => {
    const wrap = document.querySelector(".k-spotlight-map-wrap");
    wrap.classList.toggle("k-spotlight-map-wrap--expanded");
    setTimeout(() => spotlightMap.invalidateSize(), 260);
  });

  // Satellite toggle — only visible/usable while the map is expanded
  document.getElementById("k-spotlight-satellite").addEventListener("click", (e) => {
    spotlightIsSatellite = !spotlightIsSatellite;
    e.currentTarget.classList.toggle("k-map-sat-btn--active", spotlightIsSatellite);

    if (spotlightTileLayer) spotlightMap.removeLayer(spotlightTileLayer);
    spotlightTileLayer = spotlightIsSatellite
      ? L.tileLayer(SPOTLIGHT_SATELLITE_URL, { maxZoom: 19, attribution: "Tiles © Esri" }).addTo(spotlightMap)
      : L.tileLayer(SPOTLIGHT_TILE_URL, { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(spotlightMap);
  });
}

function setTileStyle(style) {
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = createTileLayer(style).addTo(map);

  document.getElementById("tile-voyager").classList.toggle("k-tile-btn--active", style === "voyager");
  document.getElementById("tile-osm").classList.toggle("k-tile-btn--active", style === "osm");
}

function fmtFuelLevel(pct) {
  return pct == null ? "n/d" : Math.round(pct) + "%";
}

function fmtOdometer(km) {
  return km == null ? "n/d" : Math.round(km).toLocaleString("it-IT") + " km";
}

function fmtFuelEconomy(v) {
  return v == null ? "n/d" : v.toFixed(1);
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

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Real driving-time estimate via OSRM's free public routing server
async function fetchReturnEtaMinutes(lat, lng) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${lng},${lat};${HOME_BASE.lng},${HOME_BASE.lat}?overview=false`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.routes && data.routes[0]) {
      return Math.round(data.routes[0].duration / 60);
    }
  } catch (err) {
    console.error("Errore calcolo tempo di rientro:", err);
  }
  return null;
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

function renderKpis(vehicles, totalDrivingSeconds, todaySpeedingEvents, speedingAvailable) {
  const total = vehicles.length;
  const moving = vehicles.filter(v => v.state === "moving").length;
  const stopped = vehicles.filter(v => v.state === "stopped").length;
  const offline = vehicles.filter(v => v.state === "offline").length;
  const totalKm = Math.round(vehicles.reduce((sum, v) => sum + (v.todayDistanceKm || 0), 0));
  const speedingText = speedingAvailable ? todaySpeedingEvents : "n/d";

  // Landscape (PC ufficio) KPI grid — unchanged, all original tiles.
  document.getElementById("kpi-total").textContent = total;
  document.getElementById("kpi-moving").textContent = moving;
  document.getElementById("kpi-stopped").textContent = stopped;
  document.getElementById("kpi-offline").textContent = offline;
  document.getElementById("kpi-km").textContent = totalKm;

  const withStops = vehicles.filter(v => v.todayStopSeconds > 0);
  const avgStopSeconds = withStops.length
    ? withStops.reduce((sum, v) => sum + v.todayStopSeconds, 0) / withStops.length
    : 0;
  document.getElementById("kpi-avg-stop").textContent = fmtDuration(avgStopSeconds);

  const totalStopSeconds = vehicles.reduce((sum, v) => sum + (v.todayStopSeconds || 0), 0);
  const totalStopCount = vehicles.reduce((sum, v) => sum + (v.todayStopCount || 0), 0);
  document.getElementById("kpi-stop-duration").textContent = fmtDuration(totalStopSeconds);
  document.getElementById("kpi-stop-count").textContent = totalStopCount;
  document.getElementById("kpi-speeding").textContent = speedingText;

  // Verticale (TV) compact strip — vehicle states aggregated into one tile,
  // plus km/engine-hours/speeding. Stop count & duration deliberately left
  // out here (still visible in "Stato flotta" and Analisi Soste).
  document.getElementById("kpiv-total").textContent = total;
  document.getElementById("kpiv-moving").textContent = moving;
  document.getElementById("kpiv-stopped").textContent = stopped;
  document.getElementById("kpiv-offline").textContent = offline;
  document.getElementById("kpiv-km").textContent = totalKm;
  document.getElementById("kpiv-driving").textContent = fmtDuration(totalDrivingSeconds || 0);
  document.getElementById("kpiv-speeding").textContent = speedingText;
}

function statusColor(state) {
  return state === "moving" ? "#34d399" : state === "stopped" ? "#fbbf24" : "#64748b";
}

function buildMarkerIcon(v, isActive) {
  const bearing = v.bearing || 0;
  const rotateStyle = v.state === "moving" ? `style="transform:rotate(${bearing}deg);"` : "";
  const labelText = v.driverName ? `${v.name} · ${v.driverName}` : v.name;
  const html = `
    <div class="k-marker ${isActive ? "k-marker--active" : ""}">
      <div class="k-marker-rotate" ${rotateStyle}>
        <div class="k-marker-shape k-marker-shape--${v.state}"></div>
      </div>
      <span class="k-marker-name">${labelText}</span>
    </div>
  `;
  return L.divIcon({ className: "", html, iconSize: [320, 24], iconAnchor: [8, 12] });
}

function renderMap(vehicles) {
  Object.values(markersByDevice).forEach(m => map.removeLayer(m));
  markersByDevice = {};

  const withPosition = vehicles.filter(v => v.latitude && v.longitude);

  withPosition.forEach(v => {
    const marker = L.marker([v.latitude, v.longitude], {
      icon: buildMarkerIcon(v, v.id === activeVehicleId)
    }).addTo(map);
    marker.on("click", () => selectVehicleManually(v.id));
    markersByDevice[v.id] = marker;
  });

  // Re-fit on every refresh so the overview stays tight around the whole
  // fleet even as vehicles move — but never zoom/pan to a single vehicle
  // (that's handled separately by the spotlight highlight, not by moving
  // the camera).
  if (withPosition.length) {
    const bounds = L.latLngBounds(withPosition.map(v => [v.latitude, v.longitude]));
    map.fitBounds(bounds.pad(0.08), { animate: false });
  }

  declutterLabels();
  setTimeout(declutterLabels, 100); // safety net once layout/fonts fully settle
}

function rosterIconHtml(v) {
  const rotateStyle = v.state === "moving" ? `style="transform:rotate(${v.bearing || 0}deg);"` : "";
  return `
    <div class="k-roster-icon">
      <div class="k-marker-rotate" ${rotateStyle}>
        <div class="k-marker-shape k-marker-shape--${v.state}"></div>
      </div>
    </div>
  `;
}

function renderRoster(vehicles) {
  const container = document.getElementById("k-roster");
  if (!vehicles.length) {
    container.innerHTML = '<p class="k-empty">Nessun veicolo trovato.</p>';
    return;
  }

  const sorted = vehicles.slice().sort((a, b) => a.name.localeCompare(b.name));

  container.innerHTML = sorted.map(v => {
    const statusText = v.state === "moving" ? "In movimento" : v.state === "stopped" ? "Fermo" : "Offline";
    const detail = v.state === "stopped"
      ? `${fmtDuration((v.stopDurationMs || 0) / 1000)}${v.location ? " · " + v.location : ""}`
      : "";
    const isActive = v.id === activeVehicleId;
    const clickable = v.latitude && v.longitude;
    return `
      <div class="k-roster-row ${isActive ? "k-roster-row--active" : ""} ${clickable ? "k-roster-row--clickable" : ""}"
           ${clickable ? `onclick="selectVehicleManually('${v.id}')"` : ""}>
        ${rosterIconHtml(v)}
        <span class="k-roster-name">${v.name}${v.driverName ? `<span class="s-driver-badge">${v.driverName}</span>` : ""}</span>
        <span class="k-spotlight-status k-spotlight-status--${v.state}">${statusText}</span>
        <span class="k-roster-detail">${detail}</span>
      </div>
    `;
  }).join("");
}

// Same treatment as locationHtml() in soste.js: a colored zone badge for a
// Geotab zone match (green if it's the home base), plain muted text for a
// reverse-geocoded address — instead of just showing raw text.
function vehicleLocationBadge(vehicle) {
  if (vehicle.zoneName) {
    const isHome = vehicle.zoneName.toLowerCase().includes(HOME_ZONE_MATCH);
    return isHome
      ? `<span class="s-zone-badge s-zone-badge--home">🏠 ${vehicle.zoneName}</span>`
      : `<span class="s-zone-badge">${vehicle.zoneName}</span>`;
  }
  if (vehicle.address) return `<span class="s-stop-address">${vehicle.address}</span>`;
  return vehicle.location || "";
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

  const lastUpdateLabel = vehicle.lastUpdate
    ? new Date(vehicle.lastUpdate).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "–";

  const locationLine = (vehicle.state === "stopped" && vehicle.location)
    ? `<div class="k-spotlight-location">📍 ${vehicleLocationBadge(vehicle)}</div>`
    : "";

  body.innerHTML = `
    <div class="k-spotlight-name">${vehicle.name}${vehicle.driverName ? `<span class="s-driver-badge">${vehicle.driverName}</span>` : ""}</div>
    <span class="k-spotlight-status k-spotlight-status--${vehicle.state}">${statusLabel}</span>
    ${locationLine}
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
      <div>
        <span class="k-spotlight-stat-value">${fmtFuelLevel(vehicle.fuelLevelPercent)}</span>
        <span class="k-spotlight-stat-label">carburante</span>
      </div>
      <div>
        <span class="k-spotlight-stat-value">${fmtOdometer(vehicle.odometerKm)}</span>
        <span class="k-spotlight-stat-label">contachilometri</span>
      </div>
      <div>
        <span class="k-spotlight-stat-value">${fmtFuelEconomy(vehicle.fuelEconomy)}</span>
        <span class="k-spotlight-stat-label">consumo l/100km</span>
      </div>
    </div>
    <div class="k-spotlight-updated">Posizione aggiornata alle ${lastUpdateLabel}</div>
    <div class="k-spotlight-eta" id="k-spotlight-eta">Rientro in sede: calcolo…</div>
  `;

  // Driving-time estimate back to base — fetched async so it doesn't block
  // the rest of the card from rendering immediately
  if (vehicle.latitude && vehicle.longitude) {
    const distToHome = haversineMeters(vehicle.latitude, vehicle.longitude, HOME_BASE.lat, HOME_BASE.lng);
    const etaEl = document.getElementById("k-spotlight-eta");
    if (distToHome <= HOME_BASE_RADIUS_M) {
      if (etaEl) etaEl.textContent = "📍 In sede";
    } else {
      fetchReturnEtaMinutes(vehicle.latitude, vehicle.longitude).then(minutes => {
        const el = document.getElementById("k-spotlight-eta");
        if (!el) return; // spotlight moved on before the response arrived
        el.textContent = minutes != null
          ? `Rientro in sede: ~${fmtDuration(minutes * 60)}`
          : "Rientro in sede: non disponibile";
      });
    }
  }

  // Mini-map: recenter on this vehicle, close zoom, single marker —
  // but not while the person is manually exploring it (rotation paused)
  const isPaused = !spotlightTimer;
  if (spotlightMap && vehicle.latitude && vehicle.longitude && !isPaused) {
    spotlightMap.setView([vehicle.latitude, vehicle.longitude], SPOTLIGHT_ZOOM);
  }
  if (spotlightMap && vehicle.latitude && vehicle.longitude) {
    if (spotlightMarker) spotlightMap.removeLayer(spotlightMarker);
    spotlightMarker = L.marker([vehicle.latitude, vehicle.longitude], {
      icon: buildMarkerIcon(vehicle, true)
    }).addTo(spotlightMap);
  }

  // Highlight this vehicle's marker — no panning or zooming, the overview
  // stays put; only the marker itself gets a brighter glow. Also mirror
  // the highlight onto the roster list below.
  activeVehicleId = vehicle.id;
  Object.entries(markersByDevice).forEach(([id, marker]) => {
    const v = currentVehicles.find(cv => String(cv.id) === id);
    if (v) marker.setIcon(buildMarkerIcon(v, id === String(vehicle.id)));
  });
  renderRoster(currentVehicles);
  declutterLabels();
}

function advanceSpotlight() {
  const withPosition = currentVehicles.filter(v => v.latitude && v.longitude);
  if (!withPosition.length) return;
  spotlightIndex = (spotlightIndex + 1) % withPosition.length;
  renderSpotlight(withPosition[spotlightIndex]);
}

function startSpotlightRotation() {
  if (spotlightTimer) clearInterval(spotlightTimer);
  spotlightTimer = setInterval(advanceSpotlight, SPOTLIGHT_INTERVAL_MS);
}

// Called when someone clicks a vehicle in the "Stato flotta" roster:
// jump straight to it, pause the automatic rotation, and resume the normal
// 15s cycle again after 30s so a manual look doesn't get interrupted right away.
function selectVehicleManually(vehicleId) {
  const withPosition = currentVehicles.filter(v => v.latitude && v.longitude);
  const idx = withPosition.findIndex(v => String(v.id) === String(vehicleId));
  if (idx === -1) return;

  spotlightIndex = idx;
  renderSpotlight(withPosition[idx]);

  if (spotlightTimer) clearInterval(spotlightTimer);
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = setTimeout(startSpotlightRotation, 30 * 1000);
}

async function refresh() {
  try {
    const resp = await fetch("/api/fleet" + (driverKey ? "?key=" + encodeURIComponent(driverKey) : ""));
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    currentVehicles = data.vehicles;
    renderKpis(currentVehicles, data.totalDrivingSeconds, data.todaySpeedingEvents, data.speedingAvailable);
    renderMap(currentVehicles);
    renderRoster(currentVehicles);

    const withPosition = currentVehicles.filter(v => v.latitude && v.longitude);
    if (withPosition.length) {
      spotlightIndex = spotlightIndex % withPosition.length;
      renderSpotlight(withPosition[spotlightIndex]);
    }

    nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
  } catch (err) {
    console.error("GRAUS Fleet Kiosk — errore aggiornamento:", err);
  }
}

document.getElementById("tile-voyager").addEventListener("click", () => setTileStyle("voyager"));
document.getElementById("tile-osm").addEventListener("click", () => setTileStyle("osm"));

startClock();
initMap("osm");
initSpotlightMap();
refresh();
setInterval(refresh, REFRESH_INTERVAL_MS);
startSpotlightRotation();
