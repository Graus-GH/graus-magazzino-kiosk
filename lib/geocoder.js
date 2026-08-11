/*
 * Reverse geocoding for stops that don't fall inside a known client Zone.
 * Uses OpenStreetMap Nominatim (free, no API key) — which requires: max
 * ~1 request/second, and a descriptive User-Agent identifying the app.
 *
 * To stay well within that limit and within the serverless function's time
 * budget, results are cached by rounded coordinate (≈11m precision), and
 * only a limited number of NEW lookups are allowed per request — anything
 * beyond that falls back to plain coordinates rather than blocking.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // addresses don't change — cache a day
const MAX_NEW_LOOKUPS_PER_REQUEST = 20;
const MIN_INTERVAL_MS = 1100; // stay under Nominatim's 1 req/sec policy

let cache = new Map(); // "lat,lng" -> { address, fetchedAt }
let lastCallAt = 0;
let lookupsThisRequest = 0;

function roundKey(lat, lng) {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

// Builds a short, human-friendly address from Nominatim's structured fields
// instead of its verbose full "display_name".
function shortAddress(addr) {
  if (!addr) return null;
  const street = [addr.road, addr.house_number].filter(Boolean).join(" ");
  const place = addr.village || addr.town || addr.city || addr.hamlet || addr.municipality;
  return [street, place].filter(Boolean).join(", ") || null;
}

async function reverseGeocode(lat, lng) {
  const key = roundKey(lat, lng);
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.address;
  }

  if (lookupsThisRequest >= MAX_NEW_LOOKUPS_PER_REQUEST) {
    return null; // budget exhausted for this request — caller falls back to coordinates
  }
  lookupsThisRequest += 1;

  // Throttle to respect Nominatim's usage policy
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastCallAt));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCallAt = Date.now();

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "GRAUS-Fleet-Kiosk/1.0 (internal warehouse dashboard)" }
    });
    const data = await resp.json();
    const address = shortAddress(data.address) || data.display_name || null;
    cache.set(key, { address, fetchedAt: Date.now() });
    return address;
  } catch (err) {
    console.error("Reverse geocoding failed for", lat, lng, err.message);
    cache.set(key, { address: null, fetchedAt: Date.now() });
    return null;
  }
}

function resetRequestBudget() {
  lookupsThisRequest = 0;
}

module.exports = { reverseGeocode, resetRequestBudget };
