import { z } from "zod";
import { sprinklrFetch } from "../client.mjs";
import { log } from "../config.mjs";

export default function register(server) {
  server.tool("sprinklr_report", "Execute Sprinklr Reporting API v2 query from dashboard payload.", {
    payload: z.string().describe("Full reporting API v2 payload as JSON string from 'Generate API v2 Payload'."),
    page_size: z.number().optional().describe("Rows per page. Default 100."),
  }, async ({ payload, page_size }) => {
    log("Tool: sprinklr_report");
    try {
      let p;
      try { p = JSON.parse(payload); } catch {
        return { content: [{ type: "text", text: "Error: invalid JSON payload." }], isError: true };
      }
      if (page_size) p.pageSize = page_size;
      const result = await sprinklrFetch("/reports/query", { method: "POST", body: p });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });
}
