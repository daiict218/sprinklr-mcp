// Connectivity test for Sprinklr MCP Server
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
dotenv.config();

const ENV = process.env.SPRINKLR_ENV || "prod4";
const BASE = `https://api2.sprinklr.com/${ENV}/api/v2`;
const KEY = process.env.SPRINKLR_API_KEY;
const TOKEN = process.env.SPRINKLR_ACCESS_TOKEN;
const MCP_CLIENT_ID = process.env.MCP_CLIENT_ID;
const MCP_CLIENT_SECRET = process.env.MCP_CLIENT_SECRET;

console.log("=== Sprinklr MCP Server Pre-flight Check ===\n");

// Check all required env vars
const required = {
  SPRINKLR_API_KEY: KEY,
  SPRINKLR_ACCESS_TOKEN: TOKEN,
  MCP_CLIENT_ID: MCP_CLIENT_ID,
  MCP_CLIENT_SECRET: MCP_CLIENT_SECRET,
};

let allPresent = true;
for (const [name, val] of Object.entries(required)) {
  const status = val ? `${val.slice(0, 8)}...` : "MISSING";
  const icon = val ? "OK" : "FAIL";
  console.log(`  [${icon}] ${name}: ${status}`);
  if (!val) allPresent = false;
}

if (!allPresent) {
  console.error("\nFix missing variables in .env before starting the server.");
  process.exit(1);
}

console.log(`\n  Environment: ${ENV}`);
console.log(`  Base URL: ${BASE}`);

// Test Sprinklr API connectivity
console.log("\nTesting Sprinklr API...");
try {
  const response = await fetch(`${BASE}/me`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      key: KEY,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    console.error(`  FAILED: HTTP ${response.status}`);
    console.error(`  ${await response.text()}`);
    process.exit(1);
  }

  const data = await response.json();
  console.log(`  Connected to Sprinklr`);
  console.log(`  User: ${data.displayName || data.email || "unknown"}`);
  console.log(`  Email: ${data.email || "N/A"}`);
  console.log(`  Client ID: ${data.clientId || "N/A"}`);
} catch (err) {
  console.error(`  FAILED: ${err.message}`);
  process.exit(1);
}

console.log("\n=== All checks passed. Run: npm start ===\n");
