/*
 * Shared Geotab API client for serverless functions.
 * Authenticates with a service account (env vars) and proxies JSON-RPC calls.
 * Session is cached across warm invocations of the same function instance.
 */

const GEOTAB_ENTRY = "https://my.geotab.com/apiv1";

let session = null;

async function authenticate() {
  const { GEOTAB_DATABASE, GEOTAB_USERNAME, GEOTAB_PASSWORD } = process.env;
  if (!GEOTAB_DATABASE || !GEOTAB_USERNAME || !GEOTAB_PASSWORD) {
    throw new Error("Missing GEOTAB_DATABASE / GEOTAB_USERNAME / GEOTAB_PASSWORD env vars");
  }

  const resp = await fetch(GEOTAB_ENTRY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "Authenticate",
      params: { database: GEOTAB_DATABASE, userName: GEOTAB_USERNAME, password: GEOTAB_PASSWORD }
    })
  });

  const data = await resp.json();
  if (data.error) {
    throw new Error("Geotab authentication failed: " + (data.error.message || JSON.stringify(data.error)));
  }

  const result = data.result;
  const server = (result.path && result.path !== "ThisServer")
    ? `https://${result.path}/apiv1`
    : GEOTAB_ENTRY;

  session = { server, credentials: result.credentials };
  return session;
}

async function geotabCall(method, params) {
  if (!session) await authenticate();

  const doCall = async () => {
    const resp = await fetch(session.server, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params: { ...params, credentials: session.credentials } })
    });
    return resp.json();
  };

  let data = await doCall();

  const isAuthError = data.error && /invaliduser|sessionid|not authenticated/i.test(
    (data.error.name || "") + " " + (data.error.message || "")
  );
  if (isAuthError) {
    await authenticate();
    data = await doCall();
  }

  if (data.error) {
    throw new Error(method + " failed: " + (data.error.message || JSON.stringify(data.error)));
  }
  return data.result;
}

module.exports = { geotabCall };
