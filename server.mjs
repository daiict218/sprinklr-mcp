import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

// =====================================================================
// CONFIGURATION
// =====================================================================

const SPRINKLR_ENV = process.env.SPRINKLR_ENV || "prod4";
const SPRINKLR_BASE_URL = `https://api2.sprinklr.com/${SPRINKLR_ENV}/api/v2`;
const SPRINKLR_OAUTH_URL = `https://api2.sprinklr.com/${SPRINKLR_ENV}/oauth`;
const API_KEY = process.env.SPRINKLR_API_KEY;
const API_SECRET = process.env.SPRINKLR_API_SECRET;
let ACCESS_TOKEN = process.env.SPRINKLR_ACCESS_TOKEN;
const REFRESH_TOKEN = process.env.SPRINKLR_REFRESH_TOKEN;
const REDIRECT_URI = process.env.SPRINKLR_REDIRECT_URI || "https://www.google.com";
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!API_KEY || !ACCESS_TOKEN) {
  console.error("ERROR: SPRINKLR_API_KEY and SPRINKLR_ACCESS_TOKEN required in .env");
  process.exit(1);
}

// =====================================================================
// AUDIT LOGGING
// =====================================================================

function auditLog(event, details = {}) {
  console.log(`[AUDIT] ${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}`);
}

// =====================================================================
// SECURITY: READ-ONLY ENFORCEMENT
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

  if (!isReadOnlyRequest(method, endpoint)) {
    auditLog("BLOCKED_WRITE_ATTEMPT", { method, endpoint });
    throw new Error(`BLOCKED: ${method} ${endpoint} not permitted. Read-only server.`);
  }

  const headers = {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    key: API_KEY,
    "Content-Type": "application/json",
  };

  const fetchOptions = { method, headers };
  if (body) fetchOptions.body = JSON.stringify(body);

  const url = endpoint.startsWith("http") ? endpoint : `${SPRINKLR_BASE_URL}${endpoint}`;
  const response = await fetch(url, fetchOptions);

  if (response.status === 401 && !retried && REFRESH_TOKEN) {
    auditLog("TOKEN_REFRESH_ATTEMPT");
    const refreshed = await refreshAccessToken();
    if (refreshed) return sprinklrFetch(endpoint, { ...options, retried: true });
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Sprinklr API ${response.status}: ${errorText}`);
  }

  return response.json();
}

async function refreshAccessToken() {
  try {
    const response = await fetch(`${SPRINKLR_OAUTH_URL}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: API_KEY,
        client_secret: API_SECRET,
        refresh_token: REFRESH_TOKEN,
        grant_type: "refresh_token",
        redirect_uri: REDIRECT_URI,
      }),
    });
    if (!response.ok) { auditLog("TOKEN_REFRESH_FAILED"); return false; }
    const data = await response.json();
    ACCESS_TOKEN = data.access_token;
    auditLog("TOKEN_REFRESH_SUCCESS");
    return true;
  } catch (err) {
    auditLog("TOKEN_REFRESH_ERROR", { error: err.message });
    return false;
  }
}

// =====================================================================
// MCP SERVER: TOOL DEFINITIONS (READ-ONLY)
// =====================================================================

function createSprinklrMcpServer() {
  const server = new McpServer({ name: "sprinklr-niva-bupa", version: "1.0.0" });

  server.tool(
    "sprinklr_me",
    "Get the current authenticated user profile from Sprinklr. Use to verify connectivity and check which tenant the token is scoped to.",
    {},
    async () => {
      auditLog("TOOL_CALL", { tool: "sprinklr_me" });
      try {
        const result = await sprinklrFetch("/me");
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "sprinklr_report",
    `Execute a Sprinklr Reporting API v2 query. Accepts a raw reporting payload (JSON) generated from any Sprinklr dashboard widget via "Generate API v2 Payload". Primary tool for pulling metrics: RPC rates, call volumes, campaign performance, agent stats, etc.`,
    {
      payload: z.string().describe("Full reporting API v2 payload as JSON string. Copy from Sprinklr dashboard widget."),
      page_size: z.number().optional().describe("Rows per page. Default 100."),
    },
    async ({ payload, page_size }) => {
      auditLog("TOOL_CALL", { tool: "sprinklr_report" });
      try {
        let p;
        try { p = JSON.parse(payload); } catch {
          return { content: [{ type: "text", text: "Error: payload must be valid JSON from 'Generate API v2 Payload'." }], isError: true };
        }
        if (page_size) p.pageSize = page_size;
        const result = await sprinklrFetch("/reports/query", { method: "POST", body: p });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "sprinklr_search_cases",
    "Search for cases (CARE tickets) in Sprinklr. Read-only.",
    {
      query: z.string().optional().describe("Free text search"),
      case_number: z.string().optional().describe("Specific case number e.g. CARE-96832"),
      status: z.string().optional().describe("Filter: OPEN, IN_PROGRESS, CLOSED"),
      page_size: z.number().optional().describe("Results to return. Default 20."),
    },
    async ({ query, case_number, status, page_size }) => {
      auditLog("TOOL_CALL", { tool: "sprinklr_search_cases", case_number });
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
    }
  );

  server.tool(
    "sprinklr_raw_api",
    "Make a read-only GET request to any Sprinklr v2 endpoint. No write operations.",
    { endpoint: z.string().describe("API path relative to /api/v2. GET only.") },
    async ({ endpoint }) => {
      auditLog("TOOL_CALL", { tool: "sprinklr_raw_api", endpoint });
      try {
        const result = await sprinklrFetch(endpoint, { method: "GET" });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "sprinklr_token_status",
    "Check Sprinklr authentication status and connectivity to the tenant.",
    {},
    async () => {
      auditLog("TOOL_CALL", { tool: "sprinklr_token_status" });
      try {
        const me = await sprinklrFetch("/me");
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "connected", environment: SPRINKLR_ENV,
              user: { id: me.id, email: me.email, displayName: me.displayName, clientId: me.clientId },
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "disconnected", error: err.message }, null, 2) }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// =====================================================================
// EXPRESS APP + MCP TRANSPORT (NO AUTH)
// =====================================================================

const app = createMcpExpressApp({ host: "0.0.0.0" });
const transports = {};

// Session cleanup
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of Object.entries(transports)) {
    if (now > entry.lastActivity + 30 * 60 * 1000) {
      delete transports[sid];
    }
  }
}, 60000);

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports[sessionId]) {
    transports[sessionId].lastActivity = Date.now();
    await transports[sessionId].transport.handleRequest(req, res, req.body);
    return;
  }

  const server = createSprinklrMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  transport.onclose = () => { const sid = transport.sessionId; if (sid) delete transports[sid]; };
  await server.connect(transport);
  if (transport.sessionId) {
    transports[transport.sessionId] = { transport, lastActivity: Date.now() };
    auditLog("SESSION_CREATED", { sessionId: transport.sessionId });
  }
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports[sessionId]) {
    transports[sessionId].lastActivity = Date.now();
    await transports[sessionId].transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No valid session." });
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].transport.handleRequest(req, res, req.body);
    delete transports[sessionId];
    return;
  }
  res.status(404).json({ error: "Session not found" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "sprinklr-mcp", version: "1.0.0", read_only: true });
});

app.use((req, res) => { res.status(404).json({ error: "not_found" }); });

// =====================================================================
// START
// =====================================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n=== Sprinklr MCP Server ===`);
  console.log(`Environment: ${SPRINKLR_ENV}`);
  console.log(`Port: ${PORT}`);
  console.log(`Auth: None (authless)`);
  console.log(`Read-only: Yes`);
  console.log(`\nEndpoints:`);
  console.log(`  MCP:    POST/GET/DELETE /mcp`);
  console.log(`  Health: GET /health`);
  console.log(`===========================\n`);
});
