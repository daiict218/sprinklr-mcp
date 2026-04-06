import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import registerMe from "./me.mjs";
import registerReport from "./report.mjs";
import registerSearchCases from "./search-cases.mjs";
import registerRawApi from "./raw-api.mjs";
import registerTokenStatus from "./token-status.mjs";

export function createSprinklrMcpServer() {
  const server = new McpServer({ name: "sprinklr-mcp", version: "0.1.0" });

  registerMe(server);
  registerReport(server);
  registerSearchCases(server);
  registerRawApi(server);
  registerTokenStatus(server);

  return server;
}
