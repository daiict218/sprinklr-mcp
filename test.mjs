// Connectivity test for Sprinklr MCP Server
import dotenv from "dotenv";
dotenv.config();

const ENV = process.env.SPRINKLR_ENV || "prod4";
const BASE = `https://api2.sprinklr.com/${ENV}/api/v2`;
const KEY = process.env.SPRINKLR_API_KEY;
const TOKEN = process.env.SPRINKLR_ACCESS_TOKEN;

console.log("=== Sprinklr MCP Server Pre-flight Check ===\n");

// Check required env vars
const required = {
  SPRINKLR_API_KEY: KEY,
  SPRINKLR_ACCESS_TOKEN: TOKEN,
};

let allPresent = true;
for (const [name, val] of Object.entries(required)) {
  const status = val ? `${val.slice(0, 8)}...` : "MISSING";
  const icon = val ? "OK" : "FAIL";
  console.log(`  [${icon}] ${name}: ${status}`);
  if (!val) allPresent = false;
}

// Check optional but recommended vars
const optional = {
  SPRINKLR_API_SECRET: process.env.SPRINKLR_API_SECRET,
  SPRINKLR_REFRESH_TOKEN: process.env.SPRINKLR_REFRESH_TOKEN,
};

for (const [name, val] of Object.entries(optional)) {
  const status = val ? `${val.slice(0, 8)}...` : "NOT SET (token refresh will not work)";
  const icon = val ? "OK" : "WARN";
  console.log(`  [${icon}] ${name}: ${status}`);
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
  const d = data.data || data;
  console.log(`  Connected to Sprinklr`);
  console.log(`  User: ${d.name || d.displayName || "unknown"}`);
  console.log(`  Email: ${d.email || "N/A"}`);
  console.log(`  Customer ID: ${d.customerId || "N/A"}`);
} catch (err) {
  console.error(`  FAILED: ${err.message}`);
  process.exit(1);
}

console.log("\n=== All checks passed. Run: npm start ===\n");
