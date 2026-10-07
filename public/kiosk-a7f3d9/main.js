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
const TIP_ROTATE_MS = 30 * 1000;
const CENTER = [46.55, 11.9]; // Alta Badia area

const TIPS = [
  "Un pneumatico sottogonfio di 0,5 bar può aumentare i consumi del 2-3%.",
  "Un minuto di motore acceso a vuoto consuma quanto 200 metri percorsi — spegnere durante le soste lunghe aiuta tutti.",
  "Pianificare le consegne per zona, quando possibile, riduce i chilometri complessivi della giornata.",
  "Accelerazioni e frenate dolci riducono l'usura dei freni e i consumi di carburante.",
  "Controllare specchietti e angoli ciechi prima di ogni manovra in retromarcia, specialmente in cortile.",
  "Una manutenzione regolare del veicolo previene i fermi imprevisti più delle riparazioni last-minute.",
  "Segnalare per tempo un problema al mezzo evita che diventi un guasto più costoso più avanti.",
  "Controllare il carico prima di partire evita soste impreviste per sistemarlo lungo il percorso.",
  "Mantenere la giusta distanza di sicurezza riduce il rischio di frenate brusche e incidenti.",
  "Un abitacolo in ordine aiuta a reagire più rapidamente in caso di imprevisti.",
  "Verificare livelli di olio e liquidi prima dei percorsi lunghi evita fermi imprevisti in strada.",
  "Comunicare per tempo un ritardo evita attese inutili in magazzino."
];

// Driver names only load if the URL has ?key=... matching DRIVER_REVEAL_KEY
// on the server. Nobody sees this on the normal kiosk URL.
const driverKey = new URLSearchParams(window.location.search).get("key");

// GRAUS bonades ZIJA — home base, taken from real stop coordinates already
// seen in the Analisi Soste zone matches. Verify/adjust if not precise.
const HOME_BASE = { lat: 46.6305, lng: 11.8956 };
const HOME_BASE_RADIUS_M = 300; // within this distance, just say "In sede"
const HOME_ZONE_MATCH = "graus"; // case-insensitive substring match on zone name, same as Analisi Soste

// Base maps. The big overview map is OpenFreeMap "Positron" (light and
// low-contrast, so vehicles and the traffic overlay stand out on a TV); the
// vehicle-detail map opens on aerial photos (Esri World Imagery) with place,
// street and business names laid over them. Plain OpenStreetMap raster tiles
// are the fallback for the big map (and the detail map's street view).
const OSM_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const SPOTLIGHT_SATELLITE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const OSM_ATTRIBUTION = "© OpenStreetMap";
const ESRI_ATTRIBUTION = "Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community";
const SPOTLIGHT_ZOOM = 16;

// Vector maps from OpenFreeMap (free, no key, commercial use allowed), drawn
// by MapLibre GL — which needs WebGL, and the TV's browser has a history of
// GPU rendering problems (see the top of this file). They're on by default,
// since it was tried and works on the TV; everything falls back to the raster
// maps above if WebGL, the libraries or the tiles aren't available. URL
// switches: ?vector=0 turns them off; ?vector=debug shows their status next
// to the credits (no console needed on the TV).
const VECTOR_PARAM = new URLSearchParams(window.location.search).get("vector");
const VECTOR_MAPS = VECTOR_PARAM !== "0";
const VECTOR_DEBUG = VECTOR_PARAM === "debug";
const OPENFREEMAP_POSITRON_STYLE = "https://tiles.openfreemap.org/styles/positron";
const OPENFREEMAP_LIBERTY_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const OPENFREEMAP_ATTRIBUTION = "OpenFreeMap © OpenMapTiles Data from OpenStreetMap";
const LABEL_TEXT_SCALE = 1.3; // the detail map is small on the TV: names need to be bigger than the style's default

// Live traffic overlay (TomTom) — on both the big overview map and the
// small vehicle-detail map. Redrawn periodically rather than on every 60s
// data refresh (which would only re-fetch tiles anyway if the view
// actually pans/zooms) — traffic doesn't need per-minute freshness, and a
// 15-minute cycle keeps this comfortably under TomTom's free tier (200k
// tile requests/month) even with both maps and a few screens open at
// once. Fails silently (no layer, no error) if TOMTOM_API_KEY isn't set
// yet — see api/tomtom-key.js.
const TOMTOM_TRAFFIC_URL_BASE = "https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png";
const TRAFFIC_REFRESH_MS = 15 * 60 * 1000;

let map;
let tileLayer;
let glBaseActive = false; // big map currently drawn by OpenFreeMap/MapLibre
let vectorStatus = ""; // shown next to the credits with ?vector=debug
let trafficActive = false;
let trafficLayer;
let spotlightTrafficLayer;
let markersByDevice = {}; // id -> Leaflet marker
let currentVehicles = [];
let spotlightIndex = 0;
let activeVehicleId = null;
let nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
let spotlightMap;
let spotlightTileLayer;
let spotlightIsSatellite = true; // opens on aerial photos; the button switches to the street map
let spotlightMarker;
let spotlightTimer = null;
let resumeTimer = null;
let rosterEtaByVehicle = {}; // id -> "In sede" | "~Nm" | null, filled in async per refresh()

function initMap() {
  // zoomAnimation off: with any3d forced off above there is no zoom animation
  // anyway, but Leaflet still *reports* it enabled, which makes the MapLibre
  // layer plugin reach for a proxy element that doesn't exist.
  map = L.map("k-map", { zoomControl: true, attributionControl: false, zoomAnimation: false }).setView(CENTER, 11);
  tileLayer = L.tileLayer(OSM_TILE_URL, { maxZoom: 19 }).addTo(map);
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
    if (trafficLayer) trafficLayer.redraw();
    // (tileLayer is null while the vector base map is in use)
  };
  setTimeout(refreshMapSize, 300);
  setTimeout(refreshMapSize, 1200);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(refreshMapSize);
  }
  window.addEventListener("resize", refreshMapSize);
}

// The big map has no Leaflet attribution control (too cluttered on a TV), so
// the credits the providers require go in one small line in the corner.
function updateMapAttribution() {
  const el = document.getElementById("k-traffic-attribution");
  if (!el) return;
  const parts = [glBaseActive ? OPENFREEMAP_ATTRIBUTION : OSM_ATTRIBUTION];
  if (trafficActive) parts.push("Traffico © TomTom");
  if (VECTOR_DEBUG && vectorStatus) parts.push("[" + vectorStatus + "]");
  el.textContent = parts.join(" · ");
  el.hidden = false;
}

// null if MapLibre can run here, otherwise a short reason.
function vectorMapsProblem() {
  if (!window.maplibregl || !L.maplibreGL) return "libreria non caricata";
  try {
    const canvas = document.createElement("canvas");
    if (!(canvas.getContext("webgl2") || canvas.getContext("webgl"))) return "WebGL assente";
  } catch (err) {
    return "WebGL assente";
  }
  return null;
}

// Big map -> OpenFreeMap Positron (vector). The OSM raster layer stays
// underneath until the vector tiles have really rendered, and comes back if
// the GL context is lost later; resolves true once the vector map is live.
function tryOpenFreeMapBase() {
  return new Promise(resolve => {
    const problem = vectorMapsProblem();
    if (problem) {
      vectorStatus = "vettoriale non attivo: " + problem;
      return resolve(false);
    }

    if (!map.getPane("baseMapPane")) map.createPane("baseMapPane").style.zIndex = 150; // under the tile pane (traffic) and markers
    const osmLayer = tileLayer;
    let settled = false;
    let gl;

    const fail = why => {
      if (settled) return;
      settled = true;
      vectorStatus = "vettoriale non attivo: " + why;
      try { if (gl) map.removeLayer(gl); } catch (err) { /* already gone */ }
      resolve(false);
    };

    try {
      gl = L.maplibreGL({ style: OPENFREEMAP_POSITRON_STYLE, pane: "baseMapPane" }).addTo(map);
    } catch (err) {
      return fail("errore " + err.message);
    }
    const glMap = gl.getMaplibreMap();
    const timer = setTimeout(() => fail("nessun tile entro 25s"), 25000);

    glMap.on("idle", () => {
      if (settled) return;
      // idle also fires when every tile failed; only a map that actually has vector data counts
      if (glMap.querySourceFeatures("openmaptiles", { sourceLayer: "transportation" }).length === 0) return;
      settled = true;
      clearTimeout(timer);
      map.removeLayer(osmLayer);
      tileLayer = null;
      glBaseActive = true;
      vectorStatus = "vettoriale OK";
      resolve(true);
    });

    glMap.getCanvas().addEventListener("webglcontextlost", () => {
      if (!glBaseActive) return fail("contesto WebGL perso");
      console.error("Contesto WebGL perso — torno a OpenStreetMap");
      glBaseActive = false;
      vectorStatus = "vettoriale interrotto (WebGL perso)";
      map.removeLayer(gl);
      osmLayer.addTo(map).bringToBack();
      tileLayer = osmLayer;
      updateMapAttribution();
    });
  });
}

async function initBaseMapStyle() {
  if (VECTOR_MAPS) await tryOpenFreeMapBase();
  updateMapAttribution(); // credits for whichever base map ended up in use
}

async function initTrafficLayer() {
  try {
    const resp = await fetch("/api/tomtom-key");
    const data = await resp.json();
    if (!data.key) return; // not configured yet — no layer, no error

    // No &thickness= here — that param 400s on the relative0 style we use
    // (only supported on absolute/relative/relative-delay/etc.); the
    // default thickness (10) applies either way.
    const trafficUrl = TOMTOM_TRAFFIC_URL_BASE + "?key=" + encodeURIComponent(data.key);

    trafficLayer = L.tileLayer(trafficUrl, { maxZoom: 19, opacity: 0.75 }).addTo(map);
    trafficActive = true;
    updateMapAttribution();

    // The detail map already has Leaflet's own attribution control on
    // (unlike the big map above), so its TomTom credit just goes through
    // that instead of a second hidden-div trick.
    if (spotlightMap) {
      spotlightTrafficLayer = L.tileLayer(trafficUrl, {
        maxZoom: 19,
        opacity: 0.75,
        attribution: "Traffico © TomTom"
      }).addTo(spotlightMap);
    }

    setInterval(() => {
      if (trafficLayer) trafficLayer.redraw();
      if (spotlightTrafficLayer) spotlightTrafficLayer.redraw();
    }, TRAFFIC_REFRESH_MS);
  } catch (err) {
    console.error("Errore caricamento layer traffico:", err);
  }
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

// Scales a MapLibre text-size value (plain number, legacy stops, or the
// "interpolate"/"step" expressions the OpenFreeMap styles use) by `k`.
function scaleTextSize(value, k) {
  if (typeof value === "number") return value * k;
  if (value && Array.isArray(value.stops)) {
    return { ...value, stops: value.stops.map(([zoom, size]) => [zoom, scaleTextSize(size, k)]) };
  }
  if (Array.isArray(value) && value[0] === "interpolate") {
    return value.map((item, i) => (i >= 4 && i % 2 === 0 ? scaleTextSize(item, k) : item)); // outputs sit at 4, 6, 8…
  }
  if (Array.isArray(value) && value[0] === "step") {
    return value.map((item, i) => (i >= 2 && i % 2 === 0 ? scaleTextSize(item, k) : item)); // outputs sit at 2, 4, 6…
  }
  return value;
}

// OpenFreeMap "Liberty" reduced to its text: place, water, street and POI
// names (bars, hotels, shops…) in white with a dark halo, bigger than the
// default — meant to sit on top of aerial imagery, with no drawn map under it.
// Which kinds of place get a name on the detail map. Deliberately leaves out
// bus stops (OpenStreetMap has a very long, trilingual name for each),
// schools, parking and street furniture: the point is to recognize where a
// vehicle is — hotels, bars, restaurants, shops, lifts.
const LABEL_POI_CLASSES = [
  "lodging", "restaurant", "bar", "cafe", "fast_food", "ice_cream", "shop", "grocery", "bakery",
  "pharmacy", "hospital", "bank", "fuel", "campsite", "attraction", "aerialway", "museum",
  "sports_centre", "stadium", "town_hall", "post"
];

function labelsOnlyStyle(libertyStyle) {
  const whiteWithHalo = layer => {
    layer.layout["text-size"] = scaleTextSize(layer.layout["text-size"], LABEL_TEXT_SCALE);
    layer.layout["text-font"] = ["Noto Sans Bold"];
    layer.paint["text-color"] = "#ffffff";
    layer.paint["text-halo-color"] = "rgba(8, 12, 20, 0.92)";
    layer.paint["text-halo-width"] = 2.2;
    layer.paint["text-halo-blur"] = 0;
    return layer;
  };
  const copy = l => ({ ...l, layout: { ...l.layout }, paint: { ...l.paint } });

  // Places, streets, water — as in the style, just restyled (towns in Italian
  // rather than the long "Corvara - Corvara in Badia" the data carries)
  const base = libertyStyle.layers
    .filter(l => l.type === "symbol" && !/^poi_|shield|arrow|airport|housenumber/.test(l.id))
    .map(l => {
      const layer = whiteWithHalo(copy(l));
      if (l["source-layer"] === "place") {
        layer.layout["text-field"] = ["coalesce", ["get", "name:it"], ["get", "name:latin"], ["get", "name"]];
      }
      return layer;
    });

  // One POI layer instead of the style's three rank bands (which let bus
  // stops crowd out hotels): chosen classes only, names only, most important
  // first when labels collide.
  const poiTemplate = libertyStyle.layers.find(l => l.id === "poi_r7");
  const poi = copy(poiTemplate);
  poi.id = "poi_names";
  poi.minzoom = 15;
  delete poi.maxzoom;
  poi.filter = ["all",
    ["match", ["geometry-type"], ["MultiPoint", "Point"], true, false],
    ["match", ["get", "class"], LABEL_POI_CLASSES, true, false]
  ];
  delete poi.layout["icon-image"]; // the icons are dark glyphs that vanish on imagery
  delete poi.layout["icon-size"];
  delete poi.layout["text-offset"];
  delete poi.layout["text-variable-anchor"];
  poi.layout["text-anchor"] = "center";
  poi.layout["symbol-sort-key"] = ["get", "rank"];
  poi.layout["text-padding"] = 3;

  return { ...libertyStyle, layers: [...base, whiteWithHalo(poi)] };
}

// Detail map: names laid over the aerial photos as a transparent MapLibre
// layer. Silently skipped if WebGL or the style isn't available.
async function initSpotlightLabels() {
  const problem = vectorMapsProblem();
  if (problem) return;
  try {
    const libertyStyle = await (await fetch(OPENFREEMAP_LIBERTY_STYLE)).json();
    if (!spotlightMap.getPane("labelsPane")) spotlightMap.createPane("labelsPane").style.zIndex = 250; // over the imagery and traffic, under the vehicle marker
    L.maplibreGL({ style: labelsOnlyStyle(libertyStyle), pane: "labelsPane" }).addTo(spotlightMap);
    spotlightMap.attributionControl.addAttribution(OPENFREEMAP_ATTRIBUTION);
    spotlightMap.getPane("labelsPane").style.display = spotlightIsSatellite ? "" : "none";
  } catch (err) {
    console.error("Errore caricamento etichette mappa di dettaglio:", err);
  }
}

function initSpotlightMap() {
  spotlightMap = L.map("k-spotlight-map", {
    zoomControl: true,
    attributionControl: true,
    zoomAnimation: false, // see initMap()
    dragging: true,
    scrollWheelZoom: true,
    doubleClickZoom: true,
    touchZoom: true
  }).setView(CENTER, SPOTLIGHT_ZOOM);
  const showSpotlightBase = () => {
    if (spotlightTileLayer) spotlightMap.removeLayer(spotlightTileLayer);
    spotlightTileLayer = (spotlightIsSatellite
      ? L.tileLayer(SPOTLIGHT_SATELLITE_URL, { maxZoom: 19, attribution: ESRI_ATTRIBUTION })
      : L.tileLayer(OSM_TILE_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION })
    ).addTo(spotlightMap);
    spotlightTileLayer.bringToBack(); // keep the traffic overlay above the base
    // The name labels only belong on the aerial photos; the street map has its own
    const labels = spotlightMap.getPane("labelsPane");
    if (labels) labels.style.display = spotlightIsSatellite ? "" : "none";
  };
  showSpotlightBase();
  document.getElementById("k-spotlight-satellite").classList.toggle("k-map-sat-btn--active", spotlightIsSatellite);
  if (VECTOR_MAPS) initSpotlightLabels();

  // Manual interaction with the detail map pauses the auto-rotation too,
  // same courtesy as clicking a vehicle in the roster.
  spotlightMap.on("dragstart zoomstart", () => {
    if (spotlightTimer) clearInterval(spotlightTimer);
    if (resumeTimer) clearTimeout(resumeTimer);
    stopRotateProgress("k-spotlight-rotate-ring");
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
    showSpotlightBase();
  });
}

function fmtFuelLevel(pct) {
  return pct == null ? "n/d" : Math.round(pct) + "%";
}

function fmtOdometer(km) {
  return km == null ? "n/d" : Math.round(km).toLocaleString("it-IT") + " km";
}

function fmtFuelEconomy(v) {
  return v == null ? "n/d" : fmtNum(v, 1);
}

// Italian convention: "." for thousands, "," for decimals (e.g. 1.234,5),
// instead of JS's default en-US-shaped stringification.
function fmtNum(n, decimals = 0) {
  return n.toLocaleString("it-IT", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
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

// Restarts the car-icon ring's fill animation from empty over `durationMs`
// — called each time a new auto-rotation cycle begins. Drives the SVG
// circle's stroke-dashoffset rather than a bar's width.
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

// Compact "return to base" label for one roster row: "In sede" needs no
// routing call (same home-radius shortcut as the spotlight card), anything
// further away gets a real OSRM estimate. Returns null (row shows nothing)
// if the vehicle has no position.
async function computeRosterEtaLabel(vehicle) {
  if (!vehicle.latitude || !vehicle.longitude) return null;
  const distToHome = haversineMeters(vehicle.latitude, vehicle.longitude, HOME_BASE.lat, HOME_BASE.lng);
  if (distToHome <= HOME_BASE_RADIUS_M) return "In sede";
  const minutes = await fetchReturnEtaMinutes(vehicle.latitude, vehicle.longitude);
  return minutes != null ? `~${fmtDuration(minutes * 60)}` : null;
}

// Refreshes every vehicle's roster ETA in parallel, then re-renders once
// they're all in — runs alongside the main data refresh() (not on every
// renderRoster() call, e.g. from spotlight rotation, which would otherwise
// hammer the routing server far more than needed).
async function refreshRosterEtas(vehicles) {
  const withPosition = vehicles.filter(v => v.latitude && v.longitude);
  const entries = await Promise.all(withPosition.map(async v => [v.id, await computeRosterEtaLabel(v)]));
  entries.forEach(([id, label]) => { rosterEtaByVehicle[id] = label; });
  renderRoster(currentVehicles);
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

function renderKpis(vehicles, totalDrivingSeconds, totalIdlingSeconds, todaySpeedingEvents, speedingAvailable) {
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
  document.getElementById("kpi-km").textContent = fmtNum(totalKm);

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
  document.getElementById("kpiv-km").textContent = fmtNum(totalKm);
  document.getElementById("kpiv-driving").textContent = fmtDuration(totalDrivingSeconds || 0);
  document.getElementById("kpiv-idling").textContent = fmtDuration(totalIdlingSeconds || 0);
  document.getElementById("kpiv-speeding").textContent = speedingText;
}

function startTips() {
  const el = document.getElementById("k-tip-text");
  if (!el) return;
  let index = Math.floor(Math.random() * TIPS.length);
  const show = () => { el.textContent = TIPS[index]; index = (index + 1) % TIPS.length; };
  show();
  setInterval(show, TIP_ROTATE_MS);
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
    const isActive = v.id === activeVehicleId;
    const clickable = v.latitude && v.longitude;
    const etaLabel = rosterEtaByVehicle[v.id];
    const etaHtml = etaLabel ? `<span class="k-roster-eta">🕒 ${etaLabel}</span>` : "";
    return `
      <div class="k-roster-row ${isActive ? "k-roster-row--active" : ""} ${clickable ? "k-roster-row--clickable" : ""}"
           ${clickable ? `onclick="selectVehicleManually('${v.id}')"` : ""}>
        ${rosterIconHtml(v)}
        <span class="k-roster-name">${v.name}${v.driverName ? `<span class="s-driver-badge">${v.driverName}</span>` : ""}</span>
        <span class="k-spotlight-status k-spotlight-status--${v.state}">${statusText}</span>
        ${etaHtml}
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

  const locationLine = (vehicle.state === "stopped" && vehicle.location)
    ? `<div class="k-spotlight-location">📍 ${vehicleLocationBadge(vehicle)}</div>`
    : "";

  body.innerHTML = `
    <div class="k-spotlight-name-row">
      <div class="k-rotate-icon" id="k-spotlight-rotate-icon" title="Prossimo veicolo">
        <svg class="k-rotate-ring" viewBox="0 0 36 36">
          <circle class="k-rotate-ring-bg" cx="18" cy="18" r="15"></circle>
          <circle class="k-rotate-ring-fg" id="k-spotlight-rotate-ring" cx="18" cy="18" r="15"></circle>
        </svg>
      </div>
      <span class="k-spotlight-name">${vehicle.name}${vehicle.driverName ? `<span class="s-driver-badge">${vehicle.driverName}</span>` : ""}</span>
    </div>
    <span class="k-spotlight-status k-spotlight-status--${vehicle.state}">${statusLabel}</span>
    ${locationLine}
    <div class="k-spotlight-stats">
      <div>
        <span class="k-spotlight-stat-value">${fmtNum(vehicle.todayDistanceKm || 0, 1)}</span>
        <span class="k-spotlight-stat-label">km oggi</span>
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
        <span class="k-spotlight-stat-label">consumo l/100km (media 30gg)</span>
      </div>
    </div>
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
  startRotateProgress("k-spotlight-rotate-ring", SPOTLIGHT_INTERVAL_MS);
}

function startSpotlightRotation() {
  if (spotlightTimer) clearInterval(spotlightTimer);
  spotlightTimer = setInterval(advanceSpotlight, SPOTLIGHT_INTERVAL_MS);
  startRotateProgress("k-spotlight-rotate-ring", SPOTLIGHT_INTERVAL_MS);
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
  stopRotateProgress("k-spotlight-rotate-ring");
  resumeTimer = setTimeout(startSpotlightRotation, 30 * 1000);
}

async function refresh() {
  try {
    const resp = await fetch("/api/fleet" + (driverKey ? "?key=" + encodeURIComponent(driverKey) : ""));
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    currentVehicles = data.vehicles;
    renderKpis(currentVehicles, data.totalDrivingSeconds, data.totalIdlingSeconds, data.todaySpeedingEvents, data.speedingAvailable);
    renderMap(currentVehicles);
    renderRoster(currentVehicles);
    refreshRosterEtas(currentVehicles);

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

startClock();
startTips();
initMap();
updateMapAttribution();
initSpotlightMap();
initBaseMapStyle();
initTrafficLayer();
refresh();
setInterval(refresh, REFRESH_INTERVAL_MS);
startSpotlightRotation();
