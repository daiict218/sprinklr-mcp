import { z } from "zod";
import { sprinklrFetch } from "../client.mjs";
import { log } from "../config.mjs";

export default function register(server) {
  server.tool("sprinklr_raw_api", "Read-only GET to any Sprinklr v2 endpoint. Access is scoped by the Sprinklr token's permissions.", {
    endpoint: z.string().describe("API path e.g. '/campaign/list'. GET only. Must start with '/'."),
  }, async ({ endpoint }) => {
    log("Tool: sprinklr_raw_api", { endpoint });
    try {
      const result = await sprinklrFetch(endpoint, { method: "GET" });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });
}
