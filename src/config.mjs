import dotenv from "dotenv";

dotenv.config();

export const SPRINKLR_ENV = process.env.SPRINKLR_ENV || "prod4";
export const SPRINKLR_BASE_URL = `https://api2.sprinklr.com/${SPRINKLR_ENV}/api/v2`;
export const SPRINKLR_OAUTH_URL = `https://api2.sprinklr.com/${SPRINKLR_ENV}/oauth`;
export const API_KEY = process.env.SPRINKLR_API_KEY;
export const API_SECRET = process.env.SPRINKLR_API_SECRET;
export let ACCESS_TOKEN = process.env.SPRINKLR_ACCESS_TOKEN;
export let REFRESH_TOKEN = process.env.SPRINKLR_REFRESH_TOKEN;
export const REDIRECT_URI = process.env.SPRINKLR_REDIRECT_URI || "https://www.google.com";
export const PORT = parseInt(process.env.PORT || "3000", 10);
export const SERVER_URL = process.env.SERVER_URL || "";

export function setAccessToken(token) { ACCESS_TOKEN = token; }
export function setRefreshToken(token) { REFRESH_TOKEN = token; }

if (!API_KEY || !ACCESS_TOKEN) {
  console.error("ERROR: SPRINKLR_API_KEY and SPRINKLR_ACCESS_TOKEN required");
  process.exit(1);
}

if (REFRESH_TOKEN && !API_SECRET) {
  console.error("ERROR: SPRINKLR_API_SECRET is required when SPRINKLR_REFRESH_TOKEN is set (needed for token refresh)");
  process.exit(1);
}

if (!REFRESH_TOKEN) {
  console.warn("WARN: SPRINKLR_REFRESH_TOKEN not set — token auto-refresh is disabled. Server will stop working when the access token expires.");
}

export function log(msg, data = {}) {
  console.log(`[${new Date().toISOString()}] ${msg}`, Object.keys(data).length ? JSON.stringify(data) : "");
}
