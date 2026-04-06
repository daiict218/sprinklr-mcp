import {
  SPRINKLR_BASE_URL, SPRINKLR_OAUTH_URL,
  API_KEY, API_SECRET, REDIRECT_URI,
  ACCESS_TOKEN, REFRESH_TOKEN,
  setAccessToken, setRefreshToken, log,
} from "./config.mjs";

const BLOCKED_METHODS = new Set(["PUT", "DELETE", "PATCH"]);
const ALLOWED_POST_ENDPOINTS = ["/reports/query", "/case/search"];

export function isReadOnlyRequest(method, endpoint) {
  const m = (method || "GET").toUpperCase();
  if (m === "GET") return true;
  if (BLOCKED_METHODS.has(m)) return false;
  if (m === "POST") return ALLOWED_POST_ENDPOINTS.some((a) => endpoint.endsWith(a));
  return false;
}

export async function sprinklrFetch(endpoint, options = {}) {
  const { method = "GET", body = null, retried = false } = options;

  if (!endpoint.startsWith("/")) {
    throw new Error(`BLOCKED: endpoint must start with '/'. Got: ${endpoint}`);
  }
  if (endpoint.includes("://") || endpoint.includes("..")) {
    throw new Error(`BLOCKED: endpoint contains forbidden sequence. Got: ${endpoint}`);
  }

  if (!isReadOnlyRequest(method, endpoint)) {
    throw new Error(`BLOCKED: ${method} ${endpoint} not permitted.`);
  }

  const headers = { Authorization: `Bearer ${ACCESS_TOKEN}`, key: API_KEY, "Content-Type": "application/json" };
  const fetchOptions = { method, headers };
  if (body) fetchOptions.body = JSON.stringify(body);

  const url = `${SPRINKLR_BASE_URL}${endpoint}`;
  const response = await fetch(url, fetchOptions);

  if (response.status === 401 && !retried && REFRESH_TOKEN) {
    log("Sprinklr token expired, refreshing...");
    const refreshed = await refreshAccessToken();
    if (refreshed) return sprinklrFetch(endpoint, { ...options, retried: true });
  }

  if (!response.ok) {
    const errorText = await response.text();
    log("Sprinklr API error", { status: response.status, body: errorText });
    throw new Error(`Sprinklr API returned HTTP ${response.status}`);
  }
  return response.json();
}

async function refreshAccessToken() {
  try {
    const response = await fetch(`${SPRINKLR_OAUTH_URL}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: API_KEY, client_secret: API_SECRET,
        refresh_token: REFRESH_TOKEN, grant_type: "refresh_token", redirect_uri: REDIRECT_URI,
      }),
    });
    if (!response.ok) return false;
    const data = await response.json();
    setAccessToken(data.access_token);
    if (data.refresh_token) setRefreshToken(data.refresh_token);
    log("Sprinklr token refreshed");
    return true;
  } catch { return false; }
}
