# Sprinklr MCP Server

An open-source [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that gives AI assistants read-only access to your Sprinklr data. Connect Claude, ChatGPT, Copilot, Cursor, or any MCP-compatible client to query Sprinklr reporting, cases, and more --- conversationally.

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-yellow?logo=buy-me-a-coffee)](https://buymeacoffee.com/daiict218)

## What It Does

- Exposes 5 read-only tools that wrap Sprinklr's REST API
- Supports both SSE and Streamable HTTP MCP transports
- Works with any Sprinklr environment (prod, prod2, prod3, prod4, prod8, etc.)
- Strictly read-only --- PUT, DELETE, PATCH are hard-blocked; POST is allowlisted to query endpoints only

## Tools

| Tool | Description |
|------|-------------|
| `sprinklr_me` | Get authenticated user profile (connectivity test) |
| `sprinklr_report` | Execute Reporting API v2 queries using dashboard widget payloads |
| `sprinklr_search_cases` | Search CARE cases by text, case number, or status |
| `sprinklr_raw_api` | GET any Sprinklr v2 endpoint (read-only escape hatch) |
| `sprinklr_token_status` | Check authentication status and tenant info |

## Prerequisites

- **Node.js 18+**
- **A Sprinklr account** with API access enabled
- **Admin or platform-level role** to create developer apps and generate API keys

---

## Setup (Complete End-to-End Guide)

### Step 1: Find Your Sprinklr Environment

Each Sprinklr instance runs on a specific environment. Your API keys and tokens are tied to that environment and cannot be used across others.

1. Log into Sprinklr in your browser
2. Open browser DevTools (**F12** or right-click > **Inspect**)
3. Press **Ctrl+F** (Windows) or **Cmd+F** (Mac) to search
4. Search for `sentry-environment`
5. The value (e.g., `prod4`) is your environment

Common environments: `prod`, `prod0`, `prod2`, `prod3`, `prod4`, `prod5`, `prod6`, `prod8`, `prod11`, `prod12`, `prod15`, `prod16`, `prod17`, `prod18`, `prod19`, `prod21`, `prod24`.

**Important:** The `prod` (production) environment uses `app.sprinklr.com` and has **no path prefix** in API URLs. All other environments include the environment name in the URL path.

### Step 2: Create a Sprinklr Developer App

You can create an app through either the Sprinklr platform or the Developer Portal.

#### Option A: In-Platform Developer Tools (Recommended)

1. Open Sprinklr and click **All Settings** from the Launchpad
2. In Platform Settings, select **Manage Customer** from the left toolbar
3. Choose **Developer Apps**
4. Click **"+ Create App"** in the top-right corner
5. Fill in the app details and create it

#### Option B: Developer Portal (dev.sprinklr.com)

1. Go to [dev.sprinklr.com](https://dev.sprinklr.com) and register an account
2. Log in, click your email in the top-right corner, select **"Apps"**
3. Click **"+ New App"**
4. Fill in the **"Register an Application"** form:
   - Application name
   - Select which Web APIs the app will use
   - Set the **Callback URL** to `https://www.google.com` (or any URL you control)
5. Click **"Register Application"**

**Tip:** Use a service account email (not a personal one) so API access persists if an individual leaves the organization.

### Step 3: Generate API Key and Secret

#### Via In-Platform Developer Tools

1. In **Developer Apps**, find your app and click the **three dots** menu
2. Select **"Manage API Key/Token"**
3. Click **"+ API Key"** in the top-right corner
4. A pop-up shows your **API Key** and **Secret**
5. **Copy both immediately** --- the Secret is only shown once

#### Via Developer Portal

1. After registering your app, the API Key is generated automatically
2. The Secret is sent via confirmation email to your registered email address
3. After email verification, both are available under **My Account**

**If you lose the Secret**, you must generate a new API Key/Secret pair.

### Step 4: Ensure Required Permissions

The Sprinklr user who will authorize the app needs these permissions:

| Permission | Purpose | Where to Enable |
|------------|---------|-----------------|
| **Generate Token** (or **Generate API Token**) | Allows OAuth token generation | All Settings > Platform Setup > Governance Console > Workspace/Global Roles |
| **Generate API v2 Payload** (or **Generate Widget API Payload**) | Allows exporting dashboard widget payloads | Same location |

Ask your Sprinklr administrator to add these permissions to your role if you don't have them.

### Step 5: Generate OAuth Tokens

Sprinklr uses OAuth 2.0 Authorization Code Grant. This is a two-step process: get a code (browser), then exchange it for tokens (API call).

#### Step 5a: Get an Authorization Code

Open this URL in your browser while logged into Sprinklr:

**For production environment (`prod`):**
```
https://api2.sprinklr.com/oauth/authorize?client_id={YOUR_API_KEY}&response_type=code&redirect_uri=https://www.google.com
```

**For other environments (e.g., `prod4`):**
```
https://api2.sprinklr.com/prod4/oauth/authorize?client_id={YOUR_API_KEY}&response_type=code&redirect_uri=https://www.google.com
```

Replace `{YOUR_API_KEY}` with your actual API Key. The `redirect_uri` must **exactly match** the Callback URL registered with your app.

After you authorize, the browser redirects to:
```
https://www.google.com/?code=62cbdbcd25968d7e2dce55gb
```

Copy the `code` value from the URL.

**Authorization codes expire in 10 minutes.** Proceed to Step 5b immediately.

#### Step 5b: Exchange the Code for Tokens

Run this command (replace the placeholders):

```bash
curl -s -X POST "https://api2.sprinklr.com/{ENV}/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id={YOUR_API_KEY}" \
  -d "client_secret={YOUR_API_SECRET}" \
  -d "code={YOUR_CODE}" \
  -d "grant_type=authorization_code" \
  -d "redirect_uri=https://www.google.com"
```

For the `prod` environment, omit the `{ENV}/` prefix: `https://api2.sprinklr.com/oauth/token`.

**Success response:**

```json
{
  "access_token": "abc123...",
  "refresh_token": "def456...",
  "token_type": "Bearer",
  "expires_in": 2591999
}
```

Save both `access_token` and `refresh_token`. You will need them in the next step.

#### Alternative: Generate Tokens from Sprinklr UI

If you prefer not to use the command line:

1. Go to **Developer Apps > Your App > Manage API Key/Token**
2. Click **"Generate Token"**
3. A screen shows your **Access Token**, **Refresh Token**, and expiry date
4. **Copy both immediately** --- they are only shown once

### Step 6: Clone and Configure

```bash
git clone https://github.com/daiict218/sprinklr-mcp.git
cd sprinklr-mcp
npm install
cp .env.example .env
```

Fill in your `.env` with the values from the previous steps:

```env
# Your Sprinklr environment (from Step 1)
SPRINKLR_ENV=prod4

# API Key and Secret (from Step 3)
SPRINKLR_API_KEY=your_api_key
SPRINKLR_API_SECRET=your_api_secret

# OAuth tokens (from Step 5)
SPRINKLR_ACCESS_TOKEN=your_access_token
SPRINKLR_REFRESH_TOKEN=your_refresh_token

# Must match the Callback URL registered with your app
SPRINKLR_REDIRECT_URI=https://www.google.com

# Leave empty for local development; set to your deployed URL when hosting
SERVER_URL=
PORT=3000
```

### Step 7: Test Connectivity

```bash
npm test
```

Expected output:
```
=== Sprinklr MCP Server Pre-flight Check ===

  [OK] SPRINKLR_API_KEY: RVezgfeO...
  [OK] SPRINKLR_ACCESS_TOKEN: 0mK30Idk...
  [OK] SPRINKLR_API_SECRET: xxxxxxxx...
  [OK] SPRINKLR_REFRESH_TOKEN: R4pZOb+t...

  Environment: prod4
  Base URL: https://api2.sprinklr.com/prod4/api/v2

Testing Sprinklr API...
  Connected to Sprinklr
  User: Your Name
  Email: your.email@company.com
  Customer ID: 123456

=== All checks passed. Run: npm start ===
```

### Step 8: Start the Server

```bash
npm start
```

The server starts on port 3000 with two MCP transports:
- **SSE:** `GET /sse` + `POST /messages` (used by Claude.ai connectors)
- **Streamable HTTP:** `POST/GET/DELETE /mcp` (newer MCP protocol)
- **Health check:** `GET /health`

---

## Connecting to AI Clients

### Claude.ai (Web)

1. Go to **Settings > Connectors > Add custom connector**
2. Enter your server URL: `https://your-deployed-url.com/sse`
3. Click **Add**
4. The 5 Sprinklr tools appear in your conversations

### Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sprinklr": {
      "url": "http://localhost:3000/sse"
    }
  }
}
```

### Cursor / Other MCP Clients

Point your MCP client to `http://localhost:3000/sse` (SSE) or `http://localhost:3000/mcp` (Streamable HTTP).

---

## Using the Reporting API

The `sprinklr_report` tool accepts raw Sprinklr Reporting API v2 payloads. To get a payload:

1. Open any Sprinklr reporting dashboard
2. Click the three dots on a widget
3. Select **"Generate API v2 Payload"** (requires the Generate Widget API Payload permission)
4. Copy the JSON

Then ask your AI assistant: *"Pull this reporting data: {paste payload}"*

The AI can also modify payloads for you --- change date ranges, add filters, adjust groupings.

---

## Deployment

### Render (Free Tier)

1. Push to GitHub
2. Create a new **Web Service** on [render.com](https://render.com)
3. Set **Build command:** `npm install`
4. Set **Start command:** `npm start`
5. Add all environment variables from your `.env`
6. Set `SERVER_URL` to your Render URL (e.g., `https://your-app.onrender.com`)

The server self-pings every 14 minutes to prevent Render's free tier from spinning down (requires `SERVER_URL` to be set).

### Railway, Fly.io, or Any Node.js Host

Same process: set environment variables, run `npm start`. The server binds to `0.0.0.0` on the port specified by `PORT`.

---

## Token Lifecycle

Understanding how Sprinklr tokens work prevents the most common issues.

| Token | Expiry | Behavior |
|-------|--------|----------|
| **Authorization code** | 10 minutes | One-time use. Get from browser, exchange immediately. |
| **Access token** | ~30 days (`expires_in: 2591999`) | Sent with every API call. Tied to your environment. |
| **Refresh token** | No expiry | **Single-use.** Each refresh returns a new refresh token; the old one is invalidated. |

### How the Server Handles Token Refresh

1. When a Sprinklr API call returns 401, the server automatically attempts to refresh the access token
2. On success, the new `access_token` is stored **in memory only** --- it is NOT written back to environment variables
3. The server logs `"Sprinklr token refreshed"` when this happens
4. If the server restarts, it re-reads the original tokens from environment variables

### What This Means for You

- **After the server logs a successful refresh:** update your environment variables (`.env` locally, hosting dashboard for deployed servers) with the new tokens before the next restart
- **If the server restarts with stale tokens:** you need to re-run the OAuth flow (Step 5 above) to get fresh tokens
- **If you run multiple instances with the same API key:** only one token exists per API key. If one instance refreshes, the other's tokens are invalidated. Use separate API keys for separate instances.

---

## Security Model

| Layer | Description |
|-------|-------------|
| **Read-only enforcement** | PUT/DELETE/PATCH blocked at the API client level. POST allowlisted to `/reports/query` and `/case/search` only. |
| **Session expiry** | Inactive MCP sessions auto-cleaned after 30 minutes. |
| **No credentials in code** | All secrets via environment variables. `.env` is gitignored. |

---

## Adding New Read-Only Endpoints

Sprinklr uses POST for many read operations. To expose additional POST endpoints:

Edit the `ALLOWED_POST_ENDPOINTS` array in `server.mjs`:

```javascript
const ALLOWED_POST_ENDPOINTS = [
  "/reports/query",
  "/case/search",
  "/voice/calls/search",  // add new endpoints here
];
```

---

## Sprinklr API Reference

### Base URLs

| Environment | API Base URL |
|-------------|-------------|
| `prod` | `https://api2.sprinklr.com/api/v2` |
| `prod4` | `https://api2.sprinklr.com/prod4/api/v2` |
| Any `{env}` | `https://api2.sprinklr.com/{env}/api/v2` |

### Required Headers

```
Authorization: Bearer {access_token}
key: {api_key}
Content-Type: application/json
```

### Rate Limits

- Default: 1,000 calls/hour, 10 calls/second per tenant
- Exceeding returns 403 with `"Developer Over Rate"`
- Contact your Sprinklr Success Manager to increase limits

### Developer Portal Links

- [Getting Started](https://dev.sprinklr.com/getting-started)
- [OAuth 2.0 for Customers](https://dev.sprinklr.com/oauth-2-0-for-customers)
- [Refreshing Access Token](https://dev.sprinklr.com/refreshing-access-token)
- [API Key and Secret Generation](https://dev.sprinklr.com/api-key-and-secret-generation)
- [Authorization Troubleshooting](https://dev.sprinklr.com/authorization-troubleshooting)
- [REST API Error Codes](https://dev.sprinklr.com/rest-api-error-and-status-codes)
- [FAQs](https://dev.sprinklr.com/faqs)

---

## Troubleshooting

### "Invalid APIKey/ClientID" (401)

Your API Key doesn't match the environment. Verify:
- The API Key belongs to the correct environment bundle
- The URL contains the correct environment prefix (e.g., `/prod4/`)
- For the `prod` environment, there is no prefix

### "Unauthorized" (401) on API calls

Access token expired or was invalidated. Either:
- The server will auto-refresh if it has a valid refresh token
- If refresh fails, re-run the OAuth flow (Step 5)

### "invalid_grant" on token exchange

The authorization code is expired (>10 minutes), already used, or the `redirect_uri` doesn't match. Get a fresh code and try again.

### Refresh token not working

Sprinklr refresh tokens are single-use. If it was already used (by this or another instance), it is dead. Re-run the full OAuth flow.

### "Developer Over Rate" (403)

You hit Sprinklr's rate limit (1,000 calls/hour). Wait and retry, or contact your Success Manager.

### Token invalidated by another instance

Only one token exists per API key. If another application or server instance generates a new token with the same API key, your tokens are invalidated. Use separate API keys for each instance.

---

## License

ISC

## Author

Ajay Gaur ([@daiict218](https://github.com/daiict218))

## Support

If you find this useful, consider [buying me a coffee](https://buymeacoffee.com/daiict218).
