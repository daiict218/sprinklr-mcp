# Sprinklr MCP Server

An open-source [MCP](https://modelcontextprotocol.io/) server that gives AI assistants read-only access to your Sprinklr data. Works with Claude, ChatGPT, Copilot, Cursor, or any MCP-compatible client.

## Prerequisites

- Node.js 18+
- Sprinklr account with API access
- Admin or platform-level role to create developer apps

## Setup

### Step 1: Find Your Sprinklr Environment

Each Sprinklr instance runs on a specific environment. Your API keys and tokens are tied to that environment and cannot be used across others.

1. Log into Sprinklr in your browser
2. Open browser DevTools (**F12** or right-click > **Inspect**)
3. Press **Ctrl+F** (Windows) or **Cmd+F** (Mac) to search
4. Search for `sentry-environment`
5. The value (e.g., `prod4`) is your environment

Common environments: `prod`, `prod2`, `prod3`, `prod4`, `prod8`.

**Note:** The `prod` environment has **no path prefix** in API URLs. All others include the environment name in the path.

### Step 2: Create a Sprinklr Developer App

1. Open Sprinklr > **All Settings** > **Manage Customer** > **Developer Apps**
2. Click **"+ Create App"** and fill in the details
3. Set the **Callback URL** to `https://www.google.com` (or any URL you control)

Alternatively, use the [Developer Portal](https://dev.sprinklr.com): register, go to **Apps** > **+ New App** > fill in the form.

### Step 3: Generate API Key and Secret

1. In **Developer Apps**, find your app > **three dots** > **"Manage API Key/Token"**
2. Click **"+ API Key"**
3. **Copy both the API Key and Secret immediately** --- the Secret is only shown once

If you lose the Secret, you must generate a new pair.

### Step 4: Ensure Required Permissions

The authorizing user needs **Generate Token** and **Generate API v2 Payload** permissions. These are managed in **All Settings > Platform Setup > Governance Console > Workspace/Global Roles**.

### Step 5: Generate OAuth Tokens

#### Step 5a: Get an Authorization Code

Open this URL in your browser (must be logged into Sprinklr):

```
https://api2.sprinklr.com/{ENV}/oauth/authorize?client_id={YOUR_API_KEY}&response_type=code&redirect_uri=https://www.google.com
```

For `prod`, omit `{ENV}/`. The `redirect_uri` must exactly match your app's Callback URL.

The browser redirects to `https://www.google.com/?code=XXXXX`. Copy the `code` value.

**Codes expire in 10 minutes** --- proceed immediately.

#### Step 5b: Exchange the Code for Tokens

```bash
curl -s -X POST "https://api2.sprinklr.com/{ENV}/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id={YOUR_API_KEY}" \
  -d "client_secret={YOUR_API_SECRET}" \
  -d "code={YOUR_CODE}" \
  -d "grant_type=authorization_code" \
  -d "redirect_uri=https://www.google.com"
```

Returns `access_token` and `refresh_token`. Save both.

**Alternative:** Generate tokens directly from the Sprinklr UI via **Developer Apps > Your App > Manage API Key/Token > Generate Token**.

### Step 6: Clone and Configure

```bash
git clone https://github.com/daiict218/sprinklr-mcp.git
cd sprinklr-mcp
npm install
cp .env.example .env
```

Fill in your `.env` with values from the previous steps. See `.env.example` for the template.

### Step 7: Test and Start

```bash
npm test   # verify Sprinklr connectivity
npm start  # start the server on port 3000
```

Endpoints:
- **SSE:** `GET /sse` + `POST /messages` (Claude.ai connectors)
- **Streamable HTTP:** `POST/GET/DELETE /mcp`
- **Health:** `GET /health`

## Connecting to AI Clients

| Client | URL |
|--------|-----|
| **Claude.ai** | Settings > Connectors > Add custom connector > `https://your-url.com/sse` |
| **Claude Desktop** | Add `{"mcpServers":{"sprinklr":{"url":"http://localhost:3000/sse"}}}` to `claude_desktop_config.json` |
| **Cursor / Others** | Point to `/sse` (SSE) or `/mcp` (Streamable HTTP) |

## Using the Reporting API

1. Open any Sprinklr reporting dashboard
2. Click three dots on a widget > **"Generate API v2 Payload"**
3. Copy the JSON payload
4. Ask your AI assistant: *"Pull this reporting data: {paste payload}"*

## Deployment

Deploy to any Node.js host (Render, Railway, Fly.io). Set all env vars from `.env` and run `npm start`.

For Render free tier, set `SERVER_URL` to your Render URL --- the server self-pings every 14 minutes to prevent spin-down.

## Token Lifecycle

| Token | Expiry | Notes |
|-------|--------|-------|
| Authorization code | 10 minutes | One-time use |
| Access token | ~30 days | Tied to environment |
| Refresh token | No expiry | **Single-use** --- each refresh invalidates the old one |

The server auto-refreshes on 401, but stores new tokens **in memory only**. If the server restarts, it re-reads from env vars. Update your env vars after a refresh, or re-run the OAuth flow if tokens go stale.

**One token per API key.** If multiple instances share an API key, one refreshing will invalidate the others. Use separate API keys per instance.

## Security

### Architecture

This MCP server is built entirely on top of Sprinklr's existing public REST APIs. It does not create any new access surface, bypass any Sprinklr access controls, or touch internal systems. Every request goes through Sprinklr's standard API gateway with the same authentication, authorization, and rate limiting that applies to any direct API consumer.

Because of this:

- **No Sprinklr security review required.** This is equivalent to a customer using Sprinklr APIs directly --- same endpoints, same credentials, same access controls.
- **Customer security teams should review.** As with any API integration, the deploying organization should review the connector as part of their standard security process.

### Deployment Model

The intended deployment model keeps all sensitive data within the customer's own infrastructure:

1. **Customer deploys the server** on their own infrastructure (Render, Railway, AWS, on-prem).
2. **Customer authenticates with their own Sprinklr credentials.** No credentials are shared with or stored by Sprinklr.
3. **LLM costs sit with the customer** --- they use their own Claude, ChatGPT, or Copilot subscription.

Sprinklr publishes the open-source connector code. Customers deploy, authenticate, and run it themselves. Zero infrastructure or AI cost on Sprinklr's side.

### Important: No Built-in Authentication

This server does not authenticate incoming MCP client connections. Anyone who can reach the server URL can invoke all tools using the configured Sprinklr credentials. This is by design for simplicity --- the server is intended to run on **private networks, localhost, or behind a reverse proxy with authentication**.

**Do not expose this server to the public internet without adding an authentication layer** (e.g., reverse proxy with OAuth, VPN, or firewall rules).

### Protections

- **Read-only enforcement:** PUT, DELETE, and PATCH are blocked at the API client level. POST is allowlisted only for `/reports/query` and `/case/search`.
- **SSRF prevention:** All endpoints must start with `/` and are validated against protocol injection (`://`) and path traversal (`..`). Requests always target the configured Sprinklr API domain.
- **Session expiry:** Inactive MCP sessions are cleaned up after 30 minutes.
- **No credentials in code:** All secrets are loaded from environment variables. `.env` is gitignored.
- **Token auto-refresh:** On 401 responses, the server refreshes the access token and stores the new refresh token for subsequent rotations.

### Token Storage

Tokens are stored **in memory only**. This is a deliberate design choice --- it avoids writing credentials to disk and keeps the attack surface minimal. The tradeoff: if the server restarts, it falls back to the tokens in your environment variables. Update your env vars after a refresh if needed, or re-run the OAuth flow.

See [Token Lifecycle](#token-lifecycle) for details on expiry and single-use refresh tokens.

## Adding New Endpoints

Add read-only POST endpoints to `ALLOWED_POST_ENDPOINTS` in `server.mjs`:

```javascript
const ALLOWED_POST_ENDPOINTS = ["/reports/query", "/case/search", "/voice/calls/search"];
```

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| "Invalid APIKey/ClientID" (401) | API Key doesn't match environment | Verify key belongs to correct environment bundle |
| "Unauthorized" (401) | Access token expired | Server auto-refreshes, or re-run OAuth flow |
| "invalid_grant" | Auth code expired/used/redirect mismatch | Get a fresh code, exchange within 10 minutes |
| Refresh token fails | Already used (single-use) | Re-run full OAuth flow |
| "Developer Over Rate" (403) | Hit 1,000 calls/hour limit | Wait, or contact Sprinklr Success Manager |

## Links

- [Sprinklr Developer Portal](https://dev.sprinklr.com)
- [OAuth 2.0 Guide](https://dev.sprinklr.com/oauth-2-0-for-customers)
- [API Key Generation](https://dev.sprinklr.com/api-key-and-secret-generation)
- [Authorization Troubleshooting](https://dev.sprinklr.com/authorization-troubleshooting)
- [REST API Error Codes](https://dev.sprinklr.com/rest-api-error-and-status-codes)

## License

ISC
