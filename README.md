# Sprinklr MCP Server (Secured)

MCP server that gives Claude read-only access to Sprinklr data via the Reporting API. Currently configured for **Niva Bupa tenant on prod4**.

## Security Model

| Layer | What it does |
|-------|-------------|
| **OAuth 2.0** | Claude.ai authenticates via standard OAuth flow. Client ID + Secret required. |
| **Bearer token** | Every MCP request validated. Invalid/expired tokens rejected with 401. |
| **Read-only enforcement** | PUT/DELETE/PATCH blocked at API client level. POST allowlisted to query endpoints only. |
| **Rate limiting** | 100 requests/minute per IP. |
| **Session expiry** | Inactive sessions auto-cleaned after 30 minutes. |
| **Audit logging** | Every tool call, auth attempt, and blocked request logged with timestamp. |
| **No credentials in code** | All secrets via environment variables. .env excluded from git. |

## Tools (Read-Only)

| Tool | Description |
|------|-------------|
| `sprinklr_me` | Get authenticated user profile (connectivity test) |
| `sprinklr_report` | Execute Reporting API v2 queries using dashboard payloads |
| `sprinklr_search_cases` | Search CARE cases by text, case number, or status |
| `sprinklr_raw_api` | GET any Sprinklr v2 endpoint (escape hatch, GET only) |
| `sprinklr_token_status` | Check authentication status and tenant info |

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Fill in all values. Generate MCP_CLIENT_ID and MCP_CLIENT_SECRET:

```bash
node -e "console.log(require('crypto').randomUUID())"
node -e "console.log(require('crypto').randomUUID())"
```

Use the first output as MCP_CLIENT_ID, second as MCP_CLIENT_SECRET. Save these, you'll need them when adding the connector in Claude.ai.

### 3. Test Sprinklr connectivity

```bash
npm test
```

### 4. Run

```bash
npm start
```

### 5. Deploy

Push to GitHub (private repo), deploy to Railway/Render. Set all env vars in the hosting dashboard.

Update `SERVER_URL` in env vars to your deployed URL (e.g., `https://sprinklr-mcp-xxxx.up.railway.app`).

### 6. Connect to Claude.ai

1. Go to **Settings > Connectors**
2. Click **"Add custom connector"**
3. Enter your server URL: `https://your-deployed-url.com/mcp`
4. Click **Advanced Settings**
5. Enter your **MCP_CLIENT_ID** and **MCP_CLIENT_SECRET**
6. Click **Add**
7. Authorize when prompted

Done. Claude can now query Sprinklr data in any conversation.

## Using the Reporting API

1. Open a Sprinklr reporting dashboard in the Niva Bupa tenant
2. Click three dots on any widget > "Generate API v2 Payload"
3. Copy the JSON payload
4. In Claude: "Pull this reporting data: {paste payload}"

## Adding More Read-Only POST Endpoints

Edit `ALLOWED_POST_ENDPOINTS` in server.mjs:

```javascript
const ALLOWED_POST_ENDPOINTS = [
  "/reports/query",
  "/case/search",
  "/voice/calls/search",  // add new read-only POST endpoints here
];
```

## Rate Limits

- MCP server: 100 requests/minute per IP
- Sprinklr API: 1,000 calls/hour (contact Success Manager to increase)

## Token Management

- MCP OAuth tokens: 24-hour expiry, auto-refresh via Claude
- Sprinklr API tokens: Auto-refresh via refresh_token in .env
- If Sprinklr token expires and refresh fails, re-run the OAuth flow
