const { geotabCall } = require("./geotabClient");

const SPEEDING_RULE_NAME = "Eccesso di velocità (nuova versione)";
const CACHE_TTL_MS = 30 * 60 * 1000; // rule id never changes — cache generously

let cache = { id: null, fetchedAt: 0 };

async function getSpeedingRuleId() {
  const now = Date.now();
  if (cache.id && (now - cache.fetchedAt) < CACHE_TTL_MS) return cache.id;

  const rules = await geotabCall("Get", {
    typeName: "Rule",
    search: { name: SPEEDING_RULE_NAME }
  });

  const id = (rules && rules.length) ? rules[0].id : null;
  cache = { id, fetchedAt: now };
  return id;
}

module.exports = { getSpeedingRuleId, SPEEDING_RULE_NAME };
