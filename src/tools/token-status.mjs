import { sprinklrFetch } from "../client.mjs";
import { SPRINKLR_ENV, log } from "../config.mjs";

export default function register(server) {
  server.tool("sprinklr_token_status", "Check Sprinklr connectivity and tenant info.", {}, async () => {
    log("Tool: sprinklr_token_status");
    try {
      const me = await sprinklrFetch("/me");
      return { content: [{ type: "text", text: JSON.stringify({ status: "connected", environment: SPRINKLR_ENV, user: { id: me.id, email: me.email, displayName: me.displayName, clientId: me.clientId } }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ status: "disconnected", error: err.message }, null, 2) }], isError: true };
    }
  });
}
