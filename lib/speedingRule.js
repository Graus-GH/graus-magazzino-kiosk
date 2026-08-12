const { geotabCall } = require("./geotabClient");

const SPEEDING_RULE_NAME = "Eccesso di velocità (nuova versione)";
const CACHE_TTL_MS = 30 * 60 * 1000; // rule id never changes — cache generously

let cache = { id: null, fetchedAt: 0 };

// Normalizes for comparison: Unicode NFC form (accented characters like
// "à" can be encoded two different ways that look identical on screen but
// compare as unequal strings), trimmed, lowercased.
function normalize(s) {
  return (s || "").normalize("NFC").trim().toLowerCase();
}

async function getSpeedingRuleId() {
  const now = Date.now();
  if (cache.id && (now - cache.fetchedAt) < CACHE_TTL_MS) return cache.id;

  // Fetch ALL rules rather than searching by exact name server-side —
  // that exact-match search was silently failing (likely the accented
  // character encoding issue above), so we match client-side instead,
  // tolerant of case/whitespace/encoding differences.
  const rules = await geotabCall("Get", { typeName: "Rule", search: {} });
  const target = normalize(SPEEDING_RULE_NAME);

  let match = rules.find(r => normalize(r.name) === target);
  if (!match) {
    // Fallback: same rule, slightly different punctuation/wording
    match = rules.find(r => {
      const n = normalize(r.name);
      return n.includes("eccesso") && n.includes("velocit");
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
