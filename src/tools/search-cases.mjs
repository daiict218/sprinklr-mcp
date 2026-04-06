import { z } from "zod";
import { sprinklrFetch } from "../client.mjs";
import { log } from "../config.mjs";

export default function register(server) {
  server.tool("sprinklr_search_cases", "Search CARE tickets in Sprinklr. Read-only.", {
    query: z.string().optional().describe("Free text search"),
    case_number: z.string().regex(/^[A-Za-z]+-\d+$/).optional().describe("Case number e.g. CARE-96832"),
    status: z.string().optional().describe("OPEN, IN_PROGRESS, CLOSED"),
    page_size: z.number().optional().describe("Results. Default 20."),
  }, async ({ query, case_number, status, page_size }) => {
    log("Tool: sprinklr_search_cases", { case_number });
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
  });
}
