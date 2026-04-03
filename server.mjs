import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import express from "express";
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

// MCP Auth credentials
const MCP_CLIENT_ID = process.env.MCP_CLIENT_ID;
const MCP_CLIENT_SECRET = process.env.MCP_CLIENT_SECRET;

// Server URL (auto-detected from request if not set)
const SERVER_URL = process.env.SERVER_URL || "";

function getBaseUrl(req) {
  if (SERVER_URL) return SERVER_URL;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

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
  console.error(`ERROR: Missing required env vars: ${missing.join(", ")}`);
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
// OAUTH 2.0 WITH PKCE
// =====================================================================

const authCodes = new Map();    // code -> { clientId, redirectUri, codeChallenge, expiresAt }
const accessTokens = new Map(); // tokenHash -> { clientId, expiresAt }

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

// PKCE: S256 = base64url(sha256(code_verifier))
function verifyPkce(codeVerifier, codeChallenge) {
  const computed = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return computed === codeChallenge;
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
  for (const [k, v] of authCodes) { if (now > v.expiresAt) authCodes.delete(k); }
  for (const [k, v] of accessTokens) { if (now > v.expiresAt) accessTokens.delete(k); }
}, 5 * 60 * 1000);

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

  server.tool("sprinklr_me", "Get the current authenticated user profile from Sprinklr.", {}, async () => {
    auditLog("TOOL_CALL", { tool: "sprinklr_me" });
    try {
      const result = await sprinklrFetch("/me");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });

  server.tool(
    "sprinklr_report",
    `Execute a Sprinklr Reporting API v2 query. Accepts a raw reporting payload (JSON) from "Generate API v2 Payload" in any dashboard widget.`,
    {
      payload: z.string().describe("Full reporting API v2 payload as JSON string."),
      page_size: z.number().optional().describe("Rows per page. Default 100."),
    },
    async ({ payload, page_size }) => {
      auditLog("TOOL_CALL", { tool: "sprinklr_report" });
      try {
        let p;
        try { p = JSON.parse(payload); } catch {
          return { content: [{ type: "text", text: "Error: payload must be valid JSON." }], isError: true };
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
      case_number: z.string().optional().describe("Specific case number"),
      status: z.string().optional().describe("Filter by status"),
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
    "Make a read-only GET request to any Sprinklr v2 endpoint.",
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

  server.tool("sprinklr_token_status", "Check Sprinklr auth status and connectivity.", {}, async () => {
    auditLog("TOOL_CALL", { tool: "sprinklr_token_status" });
    try {
      const me = await sprinklrFetch("/me");
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "connected", environment: SPRINKLR_ENV, base_url: SPRINKLR_BASE_URL,
            user: { id: me.id, email: me.email, displayName: me.displayName, clientId: me.clientId },
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ status: "disconnected", environment: SPRINKLR_ENV, error: err.message }, null, 2),
        }],
        isError: true,
      };
    }
  });

  return server;
}

// =====================================================================
// EXPRESS APP + MIDDLEWARE
// =====================================================================

const app = createMcpExpressApp({ host: "0.0.0.0" });

// URL-encoded body parsing (needed for OAuth token endpoint)
app.use("/oauth/token", express.urlencoded({ extended: true }));

// Rate limiting
app.use(rateLimit({ windowMs: 60000, max: 100, standardHeaders: true, legacyHeaders: false }));

// Auth middleware: returns proper WWW-Authenticate header for OAuth discovery
function requireAuth(req, res, next) {
  if (isValidAccessToken(req.headers.authorization)) return next();

  const base = getBaseUrl(req);
  auditLog("AUTH_REJECTED", { ip: req.ip, path: req.path });

  res.status(401);
  res.set("WWW-Authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
  res.json({ error: "unauthorized", error_description: "Bearer token required." });
}

// =====================================================================
// OAUTH 2.0 DISCOVERY ENDPOINTS
// =====================================================================

// Protected Resource Metadata (RFC 9728) -- Claude discovers this first
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const base = getBaseUrl(req);
  res.json({
    resource: base,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
  });
});

// Authorization Server Metadata (RFC 8414) -- Claude discovers this second
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const base = getBaseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    code_challenge_methods_supported: ["S256"],
  });
});

// Dynamic Client Registration (RFC 7591) -- Claude may call this
app.post("/oauth/register", (req, res) => {
  auditLog("OAUTH_DCR", { client_name: req.body?.client_name });

  // Return the pre-configured client credentials
  res.status(201).json({
    client_id: MCP_CLIENT_ID,
    client_secret: MCP_CLIENT_SECRET,
    client_name: req.body?.client_name || "Claude",
    redirect_uris: req.body?.redirect_uris || ["https://claude.ai/api/mcp/auth_callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  });
});

// =====================================================================
// OAUTH 2.0 AUTHORIZATION + TOKEN ENDPOINTS
// =====================================================================

app.get("/oauth/authorize", (req, res) => {
  const { client_id, redirect_uri, state, response_type, code_challenge, code_challenge_method } = req.query;

  auditLog("OAUTH_AUTHORIZE", { client_id, redirect_uri, code_challenge_method });

  if (response_type !== "code") {
    res.status(400).json({ error: "unsupported_response_type" });
    return;
  }

  if (client_id !== MCP_CLIENT_ID) {
    auditLog("OAUTH_INVALID_CLIENT", { client_id });
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  // Generate auth code, store PKCE challenge
  const code = generateCode();
  authCodes.set(code, {
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge || null,
    codeChallengeMethod: code_challenge_method || null,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);

  res.redirect(302, redirectUrl.toString());
});

app.post("/oauth/token", (req, res) => {
  // Accept both JSON and form-encoded bodies
  const body = req.body || {};
  const grant_type = body.grant_type;
  const code = body.code;
  const client_id = body.client_id;
  const client_secret = body.client_secret;
  const code_verifier = body.code_verifier;
  const refresh_token = body.refresh_token;

  auditLog("OAUTH_TOKEN_REQUEST", { grant_type, client_id });

  // Validate client
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

    // Verify PKCE if challenge was provided during authorization
    if (codeEntry.codeChallenge) {
      if (!code_verifier) {
        res.status(400).json({ error: "invalid_grant", error_description: "code_verifier required" });
        return;
      }
      if (!verifyPkce(code_verifier, codeEntry.codeChallenge)) {
        auditLog("PKCE_FAILED", { client_id });
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
    }

    authCodes.delete(code);

    const token = generateAccessToken();
    const tokenRefresh = `ref_${generateCode()}`;
    const expiresIn = 86400;

    accessTokens.set(hashToken(token), { clientId: client_id, expiresAt: Date.now() + expiresIn * 1000 });
    accessTokens.set(hashToken(tokenRefresh), { clientId: client_id, expiresAt: Date.now() + 30 * 86400000, isRefresh: true });

    auditLog("OAUTH_TOKEN_ISSUED", { client_id });
    res.json({ access_token: token, token_type: "bearer", expires_in: expiresIn, refresh_token: tokenRefresh });
    return;
  }

  if (grant_type === "refresh_token") {
    const refEntry = accessTokens.get(hashToken(refresh_token));
    if (!refEntry || Date.now() > refEntry.expiresAt) {
      res.status(400).json({ error: "invalid_grant", error_description: "Refresh token expired" });
      return;
    }

    const newToken = generateAccessToken();
    accessTokens.set(hashToken(newToken), { clientId: client_id, expiresAt: Date.now() + 86400000 });

    auditLog("OAUTH_TOKEN_REFRESHED", { client_id });
    res.json({ access_token: newToken, token_type: "bearer", expires_in: 86400 });
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type" });
});

// =====================================================================
// MCP ENDPOINTS (all require auth)
// =====================================================================

const transports = {};

setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of Object.entries(transports)) {
    if (now > entry.lastActivity + SESSION_TTL_MS) {
      auditLog("SESSION_EXPIRED", { sessionId: sid });
      delete transports[sid];
    }
  }
}, 60000);

app.post("/mcp", requireAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports[sessionId]) {
    transports[sessionId].lastActivity = Date.now();
    await transports[sessionId].transport.handleRequest(req, res, req.body);
    return;
  }

  const server = createSprinklrMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  transport.onclose = () => { const sid = transport.sessionId; if (sid && transports[sid]) delete transports[sid]; };
  await server.connect(transport);
  if (transport.sessionId) {
    transports[transport.sessionId] = { transport, lastActivity: Date.now() };
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
  res.status(400).json({ error: "No valid session." });
});

app.delete("/mcp", requireAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].transport.handleRequest(req, res, req.body);
    delete transports[sessionId];
    return;
  }
  res.status(404).json({ error: "Session not found" });
});

// =====================================================================
// HEALTH + CATCH-ALL
// =====================================================================

app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "sprinklr-mcp", version: "1.0.0", auth: "oauth2_pkce", read_only: true });
});

app.use((req, res) => { res.status(404).json({ error: "not_found" }); });

// =====================================================================
// START
// =====================================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n=== Sprinklr MCP Server (Secured) ===`);
  console.log(`Environment: ${SPRINKLR_ENV}`);
  console.log(`Port: ${PORT}`);
  console.log(`Auth: OAuth 2.0 + PKCE (S256)`);
  console.log(`Read-only: Yes`);
  console.log(`Rate limit: 100 req/min per IP`);
  console.log(`\nEndpoints:`);
  console.log(`  Protected Resource: GET /.well-known/oauth-protected-resource`);
  console.log(`  OAuth metadata:     GET /.well-known/oauth-authorization-server`);
  console.log(`  DCR:                POST /oauth/register`);
  console.log(`  Authorize:          GET /oauth/authorize`);
  console.log(`  Token:              POST /oauth/token`);
  console.log(`  MCP:                POST/GET/DELETE /mcp (requires Bearer)`);
  console.log(`  Health:             GET /health`);
  console.log(`====================================\n`);
});
