import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

dotenv.config();

const SPRINKLR_ENV = process.env.SPRINKLR_ENV || "prod4";
const SPRINKLR_BASE_URL = `https://api2.sprinklr.com/${SPRINKLR_ENV}/api/v2`;
const SPRINKLR_OAUTH_URL = `https://api2.sprinklr.com/${SPRINKLR_ENV}/oauth`;
const API_KEY = process.env.SPRINKLR_API_KEY;
const API_SECRET = process.env.SPRINKLR_API_SECRET;
let ACCESS_TOKEN = process.env.SPRINKLR_ACCESS_TOKEN;
let REFRESH_TOKEN = process.env.SPRINKLR_REFRESH_TOKEN;
const REDIRECT_URI = process.env.SPRINKLR_REDIRECT_URI || "https://www.google.com";
const PORT = parseInt(process.env.PORT || "3000", 10);
const SERVER_URL = process.env.SERVER_URL || "";

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

// =====================================================================
// LOGGING
// =====================================================================

function log(msg, data = {}) {
  console.log(`[${new Date().toISOString()}] ${msg}`, Object.keys(data).length ? JSON.stringify(data) : "");
}

// =====================================================================
// READ-ONLY ENFORCEMENT
// =====================================================================

const BLOCKED_METHODS = new Set(["PUT", "DELETE", "PATCH"]);
const ALLOWED_POST_ENDPOINTS = ["/reports/query", "/case/search"];

function isReadOnlyRequest(method, endpoint) {
  const m = (method || "GET").toUpperCase();
  if (m === "GET") return true;
  if (BLOCKED_METHODS.has(m)) return false;
  if (m === "POST") return ALLOWED_POST_ENDPOINTS.some((a) => endpoint.endsWith(a));
  return false;
}

// =====================================================================
// SPRINKLR API CLIENT
// =====================================================================

async function sprinklrFetch(endpoint, options = {}) {
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
    ACCESS_TOKEN = data.access_token;
    if (data.refresh_token) REFRESH_TOKEN = data.refresh_token;
    log("Sprinklr token refreshed");
    return true;
  } catch { return false; }
}

// =====================================================================
// MCP TOOLS (READ-ONLY)
// =====================================================================

function createSprinklrMcpServer() {
  const server = new McpServer({ name: "sprinklr-mcp", version: "1.0.0" });

  server.tool("sprinklr_me", "Get authenticated user profile from Sprinklr. Verifies connectivity.", {}, async () => {
    log("Tool: sprinklr_me");
    try {
      const result = await sprinklrFetch("/me");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });

  server.tool("sprinklr_report", "Execute Sprinklr Reporting API v2 query from dashboard payload.", {
    payload: z.string().describe("Full reporting API v2 payload as JSON string from 'Generate API v2 Payload'."),
    page_size: z.number().optional().describe("Rows per page. Default 100."),
  }, async ({ payload, page_size }) => {
    log("Tool: sprinklr_report");
    try {
      let p;
      try { p = JSON.parse(payload); } catch {
        return { content: [{ type: "text", text: "Error: invalid JSON payload." }], isError: true };
      }
      if (page_size) p.pageSize = page_size;
      const result = await sprinklrFetch("/reports/query", { method: "POST", body: p });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });

  server.tool("sprinklr_search_cases", "Search CARE tickets in Sprinklr. Read-only.", {
    query: z.string().optional().describe("Free text search"),
    case_number: z.string().optional().describe("Case number e.g. CARE-96832"),
    status: z.string().optional().describe("OPEN, IN_PROGRESS, CLOSED"),
    page_size: z.number().optional().describe("Results. Default 20."),
  }, async ({ query, case_number, status, page_size }) => {
    log("Tool: sprinklr_search_cases", { case_number });
    try {
      if (case_number) {
        const result = await sprinklrFetch(`/case/${case_number}`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      const sp = { page: 0, pageSize: page_size || 20, sort: { key: "createdTime", order: "DESC" } };
      if (query) sp.query = query;
      if (status) sp.filter = { status: [status] };
      const result = await sprinklrFetch("/case/search", { method: "POST", body: sp });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });

  server.tool("sprinklr_raw_api", "Read-only GET to any Sprinklr v2 endpoint. Access is scoped by the Sprinklr token's permissions.", {
    endpoint: z.string().describe("API path e.g. '/campaign/list'. GET only. Must start with '/'."),
  }, async ({ endpoint }) => {
    log("Tool: sprinklr_raw_api", { endpoint });
    try {
      const result = await sprinklrFetch(endpoint, { method: "GET" });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });

  server.tool("sprinklr_token_status", "Check Sprinklr connectivity and tenant info.", {}, async () => {
    log("Tool: sprinklr_token_status");
    try {
      const me = await sprinklrFetch("/me");
      return { content: [{ type: "text", text: JSON.stringify({ status: "connected", environment: SPRINKLR_ENV, user: { id: me.id, email: me.email, displayName: me.displayName, clientId: me.clientId } }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "disconnected", error: err.message }, null, 2) }], isError: true };
    }
  });

  return server;
}

// =====================================================================
// EXPRESS + TRANSPORTS
// =====================================================================

const app = createMcpExpressApp({ host: "0.0.0.0" });
app.set("trust proxy", 1);

// --- Security headers (tuned for API server, not browser app) ---
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
}));

// --- Rate limiting ---
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

const mcpLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many MCP requests, please try again later." },
});

app.use(globalLimiter);
app.use("/mcp", mcpLimiter);
app.use("/messages", mcpLimiter);
app.use("/sse", mcpLimiter);

// Log EVERY incoming request for debugging
app.use((req, res, next) => {
  log("REQUEST", { method: req.method, path: req.path, headers: { accept: req.headers.accept, "content-type": req.headers["content-type"], "mcp-session-id": req.headers["mcp-session-id"] } });
  next();
});

// --- Streamable HTTP transport ---
const transports = {};

setInterval(() => {
  const now = Date.now();
  for (const [sid, e] of Object.entries(transports)) {
    if (now > e.lastActivity + 30 * 60 * 1000) delete transports[sid];
  }
}, 60000);

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && transports[sessionId]) {
      transports[sessionId].lastActivity = Date.now();
      await transports[sessionId].transport.handleRequest(req, res, req.body);
      return;
    }

    log("Creating new MCP session");
    const server = createSprinklrMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    transport.onclose = () => { const sid = transport.sessionId; if (sid) delete transports[sid]; };
    await server.connect(transport);
    if (transport.sessionId) {
      transports[transport.sessionId] = { transport, lastActivity: Date.now() };
      log("Session created", { sessionId: transport.sessionId });
    }
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log("ERROR in POST /mcp", { error: err.message, stack: err.stack });
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && transports[sessionId]) {
      transports[sessionId].lastActivity = Date.now();
      await transports[sessionId].transport.handleRequest(req, res);
      return;
    }
    res.status(400).json({ error: "No session." });
  } catch (err) {
    log("ERROR in GET /mcp", { error: err.message });
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.delete("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].transport.handleRequest(req, res, req.body);
      delete transports[sessionId];
      return;
    }
    res.status(404).json({ error: "Session not found" });
  } catch (err) {
    log("ERROR in DELETE /mcp", { error: err.message });
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// --- SSE transport (fallback for Claude.ai compatibility) ---
const sseTransports = {};

setInterval(() => {
  const now = Date.now();
  for (const [sid, transport] of Object.entries(sseTransports)) {
    if (transport._lastActivity && now > transport._lastActivity + 30 * 60 * 1000) {
      transport.close?.();
      delete sseTransports[sid];
    }
  }
}, 60000);

app.get("/sse", async (req, res) => {
  try {
    log("SSE connection requested");
    const transport = new SSEServerTransport("/messages", res);
    const server = createSprinklrMcpServer();
    transport._lastActivity = Date.now();
    sseTransports[transport.sessionId] = transport;
    transport.onclose = () => { delete sseTransports[transport.sessionId]; };
    await server.connect(transport);
    log("SSE session created", { sessionId: transport.sessionId });
  } catch (err) {
    log("ERROR in GET /sse", { error: err.message });
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.post("/messages", async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    log("SSE message received", { sessionId });
    const transport = sseTransports[sessionId];
    if (transport) {
      transport._lastActivity = Date.now();
      await transport.handlePostMessage(req, res, req.body);
    } else {
      res.status(404).json({ error: "SSE session not found" });
    }
  } catch (err) {
    log("ERROR in POST /messages", { error: err.message });
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// --- Health ---
app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "sprinklr-mcp", version: "1.0.0", read_only: true, transports: ["streamable-http", "sse"] });
});

app.use((req, res) => {
  log("404", { method: req.method, path: req.path });
  res.status(404).json({ error: "not_found" });
});

// --- Self-ping to prevent Render free tier spin-down ---
if (SERVER_URL) {
  setInterval(() => {
    fetch(`${SERVER_URL}/health`).catch(() => {});
  }, 14 * 60 * 1000);
  log("Self-ping enabled", { url: SERVER_URL, interval: "14 min" });
}

// --- Start ---
app.listen(PORT, "0.0.0.0", () => {
  log("=== Sprinklr MCP Server Started ===");
  log(`Environment: ${SPRINKLR_ENV}`);
  log(`Port: ${PORT}`);
  log(`Streamable HTTP: POST/GET/DELETE /mcp`);
  log(`SSE: GET /sse + POST /messages`);
  log(`Health: GET /health`);
  log(`Auth: None (deploy behind a reverse proxy or on a private network)`);
  log(`Read-only: Yes`);
  log("===================================");
});
