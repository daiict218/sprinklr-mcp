import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
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

// MCP Auth credentials (what you enter in Claude.ai connector settings)
const MCP_CLIENT_ID = process.env.MCP_CLIENT_ID;
const MCP_CLIENT_SECRET = process.env.MCP_CLIENT_SECRET;

// Server's public URL (needed for OAuth metadata)
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;

// Session expiry (30 minutes of inactivity)
const SESSION_TTL_MS = 30 * 60 * 1000;

// =====================================================================
// STARTUP VALIDATION
// =====================================================================

const missing = [];
if (!API_KEY) missing.push("SPRINKLR_API_KEY");
if (!ACCESS_TOKEN) missing.push("SPRINKLR_ACCESS_TOKEN");
if (!MCP_CLIENT_ID) missing.push("MCP_CLIENT_ID");
if (!MCP_CLIENT_SECRET) missing.push("MCP_CLIENT_SECRET");

if (missing.length > 0) {
  console.error(`ERROR: Missing required environment variables: ${missing.join(", ")}`);
  console.error("Copy .env.example to .env and fill in all required values.");
  process.exit(1);
}

// =====================================================================
// AUDIT LOGGING
// =====================================================================

function auditLog(event, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    ...details,
  };
  console.log(`[AUDIT] ${JSON.stringify(entry)}`);
}

// =====================================================================
// SECURITY: READ-ONLY ENFORCEMENT
// =====================================================================
// This server is strictly read-only. No create, update, or delete
// operations are permitted against the Sprinklr API.
//
// Enforced at two levels:
// 1. HTTP method blocking: PUT, DELETE, PATCH rejected before any call
// 2. POST allowlist: Only known read-only POST endpoints permitted

const BLOCKED_METHODS = new Set(["PUT", "DELETE", "PATCH"]);

const ALLOWED_POST_ENDPOINTS = [
  "/reports/query",
  "/case/search",
];

function isReadOnlyRequest(method, endpoint) {
  const upperMethod = (method || "GET").toUpperCase();
  if (upperMethod === "GET") return true;
  if (BLOCKED_METHODS.has(upperMethod)) return false;
  if (upperMethod === "POST") {
    return ALLOWED_POST_ENDPOINTS.some((allowed) => endpoint.endsWith(allowed));
  }
  return false;
}

// =====================================================================
// SECURITY: OAUTH 2.0 FOR MCP AUTH
// =====================================================================
// Claude.ai uses OAuth 2.0 to authenticate with MCP servers.
// Flow:
// 1. Claude discovers OAuth metadata via /.well-known/oauth-authorization-server
// 2. Redirects user to /oauth/authorize
// 3. User authorizes, gets redirected back with a code
// 4. Claude exchanges code for bearer token at /oauth/token
// 5. All MCP requests include Authorization: Bearer <token>
//
// The client_id and client_secret are set via env vars.
// You enter these in Claude.ai > Settings > Connectors > Advanced Settings.

// In-memory stores (fine for single-instance personal server)
const authCodes = new Map();    // code -> { clientId, expiresAt }
const accessTokens = new Map(); // tokenHash -> { clientId, expiresAt }

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function generateCode() {
  return randomUUID().replace(/-/g, "");
}

function generateAccessToken() {
  return `spr_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
}

function isValidAccessToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  const hash = hashToken(token);
  const entry = accessTokens.get(hash);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    accessTokens.delete(hash);
    return false;
  }
  return true;
}

// Cleanup expired tokens/codes every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of authCodes) {
    if (now > val.expiresAt) authCodes.delete(key);
  }
  for (const [key, val] of accessTokens) {
    if (now > val.expiresAt) accessTokens.delete(key);
  }
}, 5 * 60 * 1000);

// =====================================================================
// SPRINKLR API CLIENT
// =====================================================================

async function sprinklrFetch(endpoint, options = {}) {
  const { method = "GET", body = null, retried = false } = options;

  if (!isReadOnlyRequest(method, endpoint)) {
    auditLog("BLOCKED_WRITE_ATTEMPT", { method, endpoint });
    throw new Error(
      `BLOCKED: ${method} ${endpoint} is not permitted. This server is read-only.`
    );
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
    if (refreshed) {
      return sprinklrFetch(endpoint, { ...options, retried: true });
    }
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

    if (!response.ok) {
      auditLog("TOKEN_REFRESH_FAILED", { status: response.status });
      return false;
    }

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
  const server = new McpServer({
    name: "sprinklr-niva-bupa",
    version: "1.0.0",
  });

  // Tool 1: Connection test
  server.tool(
    "sprinklr_me",
    "Get the current authenticated user profile from Sprinklr. Use this to verify connectivity and check which tenant and user the token is scoped to.",
    {},
    async () => {
      auditLog("TOOL_CALL", { tool: "sprinklr_me" });
      try {
        const result = await sprinklrFetch("/me");
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 2: Reporting API (the main workhorse)
  server.tool(
    "sprinklr_report",
    `Execute a Sprinklr Reporting API v2 query. Accepts a raw reporting payload (JSON object) generated from any Sprinklr dashboard widget via "Generate API v2 Payload". Primary tool for pulling metrics: RPC rates, call volumes, campaign performance, agent stats, etc.`,
    {
      payload: z
        .string()
        .describe(
          "The full reporting API v2 payload as a JSON string. Copy from Sprinklr dashboard widget via 'Generate API v2 Payload'."
        ),
      page_size: z
        .number()
        .optional()
        .describe("Number of rows to return per page. Default is 100."),
    },
    async ({ payload, page_size }) => {
      auditLog("TOOL_CALL", { tool: "sprinklr_report", page_size });
      try {
        let parsedPayload;
        try {
          parsedPayload = JSON.parse(payload);
        } catch {
          return {
            content: [
              {
                type: "text",
                text: "Error: payload must be a valid JSON string. Copy the exact output from Sprinklr's 'Generate API v2 Payload' option.",
              },
            ],
            isError: true,
          };
        }

        if (page_size) parsedPayload.pageSize = page_size;

        const result = await sprinklrFetch("/reports/query", {
          method: "POST",
          body: parsedPayload,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 3: Case search (read-only)
  server.tool(
    "sprinklr_search_cases",
    "Search for cases (support tickets) in Sprinklr. Read-only. Returns case details including status, assignee, priority, and description.",
    {
      query: z.string().optional().describe("Free text search query"),
      case_number: z
        .string()
        .optional()
        .describe("Specific case number (e.g., CARE-96832)"),
      status: z
        .string()
        .optional()
        .describe("Filter by status: OPEN, IN_PROGRESS, CLOSED, etc."),
      page_size: z.number().optional().describe("Results to return. Default 20."),
    },
    async ({ query, case_number, status, page_size }) => {
      auditLog("TOOL_CALL", { tool: "sprinklr_search_cases", case_number, query });
      try {
        if (case_number) {
          const result = await sprinklrFetch(`/case/${case_number}`);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }

        const searchPayload = {
          page: 0,
          pageSize: page_size || 20,
          sort: { key: "createdTime", order: "DESC" },
        };
        if (query) searchPayload.query = query;
        if (status) searchPayload.filter = { status: [status] };

        const result = await sprinklrFetch("/case/search", {
          method: "POST",
          body: searchPayload,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 4: Raw API (GET-only escape hatch)
  server.tool(
    "sprinklr_raw_api",
    "Make a read-only GET request to any Sprinklr v2 endpoint. No write operations permitted.",
    {
      endpoint: z
        .string()
        .describe(
          "API path relative to /api/v2, e.g., '/campaign/list'. GET only."
        ),
    },
    async ({ endpoint }) => {
      auditLog("TOOL_CALL", { tool: "sprinklr_raw_api", endpoint });
      try {
        const result = await sprinklrFetch(endpoint, { method: "GET" });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool 5: Token status
  server.tool(
    "sprinklr_token_status",
    "Check authentication status and connectivity to the Sprinklr tenant.",
    {},
    async () => {
      auditLog("TOOL_CALL", { tool: "sprinklr_token_status" });
      try {
        const me = await sprinklrFetch("/me");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "connected",
                  environment: SPRINKLR_ENV,
                  base_url: SPRINKLR_BASE_URL,
                  user: {
                    id: me.id,
                    email: me.email,
                    displayName: me.displayName,
                    clientId: me.clientId,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "disconnected",
                  environment: SPRINKLR_ENV,
                  error: err.message,
                  hint: "Token may have expired. Check .env or re-run OAuth flow.",
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

// =====================================================================
// EXPRESS APP + SECURITY MIDDLEWARE
// =====================================================================

const app = createMcpExpressApp({ host: "0.0.0.0" });

// Rate limiting: 100 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded. Try again in a minute." },
});
app.use(limiter);

// Bearer token auth middleware for MCP endpoints
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!isValidAccessToken(authHeader)) {
    auditLog("AUTH_REJECTED", {
      ip: req.ip,
      path: req.path,
      reason: authHeader ? "invalid_token" : "missing_token",
    });
    res.status(401).json({
      error: "unauthorized",
      error_description: "Valid Bearer token required. Complete OAuth flow first.",
    });
    return;
  }
  next();
}

// =====================================================================
// OAUTH 2.0 ENDPOINTS
// =====================================================================

// Metadata discovery (required by Claude.ai)
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer: SERVER_URL,
    authorization_endpoint: `${SERVER_URL}/oauth/authorize`,
    token_endpoint: `${SERVER_URL}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    code_challenge_methods_supported: ["S256"],
  });
});

// Authorization endpoint
app.get("/oauth/authorize", (req, res) => {
  const { client_id, redirect_uri, state, response_type } = req.query;

  auditLog("OAUTH_AUTHORIZE", { client_id, redirect_uri });

  if (response_type !== "code") {
    res.status(400).json({ error: "unsupported_response_type" });
    return;
  }

  if (client_id !== MCP_CLIENT_ID) {
    auditLog("OAUTH_INVALID_CLIENT", { client_id });
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  // Auto-approve (personal server, single user)
  // Generate authorization code
  const code = generateCode();
  authCodes.set(code, {
    clientId: client_id,
    redirectUri: redirect_uri,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
  });

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);

  res.redirect(302, redirectUrl.toString());
});

// Token endpoint
app.post("/oauth/token", (req, res) => {
  const { grant_type, code, client_id, client_secret, refresh_token } = req.body;

  auditLog("OAUTH_TOKEN_REQUEST", { grant_type, client_id });

  // Validate client credentials
  if (client_id !== MCP_CLIENT_ID || client_secret !== MCP_CLIENT_SECRET) {
    auditLog("OAUTH_INVALID_CREDENTIALS", { client_id });
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  if (grant_type === "authorization_code") {
    const codeEntry = authCodes.get(code);
    if (!codeEntry || Date.now() > codeEntry.expiresAt) {
      res.status(400).json({ error: "invalid_grant", error_description: "Code expired or invalid" });
      return;
    }

    authCodes.delete(code);

    // Issue access token (24 hour expiry)
    const token = generateAccessToken();
    const tokenRefresh = `ref_${generateCode()}`;
    const expiresIn = 86400;

    accessTokens.set(hashToken(token), {
      clientId: client_id,
      expiresAt: Date.now() + expiresIn * 1000,
    });
    accessTokens.set(hashToken(tokenRefresh), {
      clientId: client_id,
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 day refresh
      isRefresh: true,
    });

    auditLog("OAUTH_TOKEN_ISSUED", { client_id });

    res.json({
      access_token: token,
      token_type: "bearer",
      expires_in: expiresIn,
      refresh_token: tokenRefresh,
    });
    return;
  }

  if (grant_type === "refresh_token") {
    const refEntry = accessTokens.get(hashToken(refresh_token));
    if (!refEntry || Date.now() > refEntry.expiresAt) {
      res.status(400).json({ error: "invalid_grant", error_description: "Refresh token expired" });
      return;
    }

    // Issue new access token
    const newToken = generateAccessToken();
    const expiresIn = 86400;

    accessTokens.set(hashToken(newToken), {
      clientId: client_id,
      expiresAt: Date.now() + expiresIn * 1000,
    });

    auditLog("OAUTH_TOKEN_REFRESHED", { client_id });

    res.json({
      access_token: newToken,
      token_type: "bearer",
      expires_in: expiresIn,
    });
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type" });
});

// =====================================================================
// MCP ENDPOINTS (all require auth)
// =====================================================================

const transports = {};

// Session cleanup: remove stale sessions
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of Object.entries(transports)) {
    if (now > entry.lastActivity + SESSION_TTL_MS) {
      auditLog("SESSION_EXPIRED", { sessionId: sid });
      delete transports[sid];
    }
  }
}, 60 * 1000);

app.post("/mcp", requireAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && transports[sessionId]) {
    transports[sessionId].lastActivity = Date.now();
    await transports[sessionId].transport.handleRequest(req, res, req.body);
    return;
  }

  const server = createSprinklrMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid && transports[sid]) {
      auditLog("SESSION_CLOSED", { sessionId: sid });
      delete transports[sid];
    }
  };

  await server.connect(transport);

  if (transport.sessionId) {
    transports[transport.sessionId] = {
      transport,
      lastActivity: Date.now(),
    };
    auditLog("SESSION_CREATED", { sessionId: transport.sessionId });
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", requireAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports[sessionId]) {
    transports[sessionId].lastActivity = Date.now();
    await transports[sessionId].transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No valid session. POST /mcp to initialize." });
});

app.delete("/mcp", requireAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].transport.handleRequest(req, res, req.body);
    auditLog("SESSION_DELETED", { sessionId });
    delete transports[sessionId];
    return;
  }
  res.status(404).json({ error: "Session not found" });
});

// =====================================================================
// HEALTH CHECK (no auth required, reveals nothing sensitive)
// =====================================================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    server: "sprinklr-mcp",
    version: "1.0.0",
    auth: "oauth2",
    read_only: true,
  });
});

// Block all other routes
app.use((req, res) => {
  res.status(404).json({ error: "not_found" });
});

// =====================================================================
// START
// =====================================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n=== Sprinklr MCP Server (Secured) ===`);
  console.log(`Environment: ${SPRINKLR_ENV}`);
  console.log(`Port: ${PORT}`);
  console.log(`Auth: OAuth 2.0 (client_credentials required)`);
  console.log(`Read-only: Yes (PUT/DELETE/PATCH blocked, POST allowlisted)`);
  console.log(`Rate limit: 100 req/min per IP`);
  console.log(`Session TTL: ${SESSION_TTL_MS / 60000} minutes`);
  console.log(`\nEndpoints:`);
  console.log(`  OAuth metadata: GET /.well-known/oauth-authorization-server`);
  console.log(`  Authorize:      GET /oauth/authorize`);
  console.log(`  Token:          POST /oauth/token`);
  console.log(`  MCP:            POST/GET/DELETE /mcp (requires Bearer token)`);
  console.log(`  Health:         GET /health`);
  console.log(`\n====================================\n`);
});
