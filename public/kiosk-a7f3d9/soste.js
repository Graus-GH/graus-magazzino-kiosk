/*
 * GRAUS Fleet Kiosk — Analisi Soste view logic
 */

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // heavier endpoint — refresh less often

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
      <div class="s-vehicle-sub">${v.stopCount} sost${v.stopCount === 1 ? "a" : "e"} oggi</div>
      <div class="s-stop-list">
        ${v.stops.length ? v.stops.map(s => `
          <div class="s-stop ${s.ongoing ? "s-stop--ongoing" : ""}">
            <div class="s-stop-top">
              <span class="s-stop-time">${s.startLabel} → ${s.endLabel}</span>
              <span class="s-stop-duration">${fmtDuration(s.durationSeconds)}</span>
            </div>
            <div class="s-stop-location">
              ${s.zoneName ? `<span class="s-zone-badge">${s.zoneName}</span>` : ""}
              <a href="${s.mapUrl}" target="_blank" rel="noopener">${s.lat}, ${s.lng}</a>
            </div>
          </div>
        `).join("") : '<p class="k-empty">Nessuna sosta rilevata oggi.</p>'}
      </div>
    </div>
  `).join("");
}

async function refresh() {
  try {
    const resp = await fetch("/api/stops");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    renderVehicles(data.vehicles);
    document.getElementById("k-updated").textContent =
      "Aggiornato alle " + fmtClock(new Date());
  } catch (err) {
    console.error("GRAUS Fleet Kiosk (soste) — errore aggiornamento:", err);
    document.getElementById("k-updated").textContent =
      "Errore di aggiornamento — nuovo tentativo tra poco";
  }
}

startClock();
refresh();
setInterval(refresh, REFRESH_INTERVAL_MS);
