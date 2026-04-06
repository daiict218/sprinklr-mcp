import { sprinklrFetch } from "../client.mjs";
import { log } from "../config.mjs";

export default function register(server) {
  server.tool("sprinklr_me", "Get authenticated user profile from Sprinklr. Verifies connectivity.", {}, async () => {
    log("Tool: sprinklr_me");
    try {
      const result = await sprinklrFetch("/me");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });
}
