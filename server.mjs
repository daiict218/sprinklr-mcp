#!/usr/bin/env node
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { randomUUID } from "node:crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import { PORT, SERVER_URL, SPRINKLR_ENV, log } from "./src/config.mjs";
import { createSprinklrMcpServer } from "./src/tools/index.mjs";

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
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many MCP requests, please try again later." },
});

app.use(globalLimiter);
app.use("/mcp", mcpLimiter);
app.use("/messages", mcpLimiter);
app.use("/sse", mcpLimiter);

// Log incoming requests
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
  res.json({ status: "ok", server: "sprinklr-mcp", version: "0.1.0", read_only: true, transports: ["streamable-http", "sse"] });
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
