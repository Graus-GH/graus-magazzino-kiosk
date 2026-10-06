/*
 * Minimal Upstash Redis REST client. The Vercel Marketplace integration
 * injects KV_REST_API_URL / KV_REST_API_TOKEN (older setups use the
 * UPSTASH_REDIS_REST_* names — both are accepted).
 *
 * Needed because Vercel functions have no writable persistent storage, and
 * SolarEdge's OAuth refresh token rotates on every use: the newest pair has
 * to live somewhere shared between invocations.
 */

function config() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("Missing Upstash Redis env vars (KV_REST_API_URL / KV_REST_API_TOKEN)");
  }
  return { url, token };
}

async function command(args) {
  const { url, token } = config();
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args)
  });
  const data = await resp.json();
  if (!resp.ok || data.error) {
    throw new Error(`Upstash error: ${data.error || resp.status}`);
  }
  return data.result;
}

async function getJson(key) {
  const raw = await command(["GET", key]);
  return raw == null ? null : JSON.parse(raw);
}

async function setJson(key, value, ttlSeconds) {
  const args = ["SET", key, JSON.stringify(value)];
  if (ttlSeconds) args.push("EX", String(ttlSeconds));
  await command(args);
}

// True if this caller got the lock; it expires on its own after ttlSeconds
// so a crashed invocation can't wedge it forever.
async function acquireLock(key, ttlSeconds) {
  return (await command(["SET", key, "1", "NX", "EX", String(ttlSeconds)])) === "OK";
}

async function exists(key) {
  return (await command(["EXISTS", key])) === 1;
}

async function del(key) {
  await command(["DEL", key]);
}

async function incrBy(key, amount) {
  return command(["INCRBY", key, String(amount)]);
}

async function expire(key, ttlSeconds) {
  await command(["EXPIRE", key, String(ttlSeconds)]);
}

module.exports = { getJson, setJson, acquireLock, exists, del, incrBy, expire };
