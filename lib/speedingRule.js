const { geotabCall } = require("./geotabClient");

// Geotab's built-in system rules store their name internally in English —
// what you see in the MyGeotab UI ("Eccesso di velocità (nuova versione)")
// is just the localized display label, not the actual API name.
const SPEEDING_RULE_NAME = "Speeding (New)";
const CACHE_TTL_MS = 30 * 60 * 1000; // rule id never changes — cache generously

let cache = { id: null, fetchedAt: 0 };

function normalize(s) {
  return (s || "").normalize("NFC").trim().toLowerCase();
}

async function getSpeedingRuleId() {
  const now = Date.now();
  if (cache.id && (now - cache.fetchedAt) < CACHE_TTL_MS) return cache.id;

  const rules = await geotabCall("Get", { typeName: "Rule", search: {} });
  const target = normalize(SPEEDING_RULE_NAME);

  let match = rules.find(r => normalize(r.name) === target);
  if (!match) {
    // Fallback: tolerant of Italian label or slight rewording
    match = rules.find(r => {
      const n = normalize(r.name);
      return n.includes("speeding") || (n.includes("eccesso") && n.includes("velocit"));
    });
  }

  if (!match) {
    console.error(
      "Speeding rule not found. Looking for:", SPEEDING_RULE_NAME,
      "— available rule names:", rules.map(r => r.name).join(" | ")
    );
  }

  const id = match ? match.id : null;
  cache = { id, fetchedAt: now };
  return id;
}

module.exports = { getSpeedingRuleId, SPEEDING_RULE_NAME };
