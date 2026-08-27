import type { McpServer } from "@modelcontextprotocol/server";
import { loadTokens } from "../auth/tokenStorage.js";
import { requireSessionContext } from "../utils/sessionContext.js";

export function registerResources(server: McpServer): void {
  server.registerResource(
    "auth-status",
    "jobber://auth/status",
    {
      title: "Auth Status",
      description: "Current authentication state with Jobber",
      mimeType: "application/json",
    },
    async (uri) => {
      const ctx = requireSessionContext();
      const tokens = ctx ? ctx.getTokens() : await loadTokens();

      const payload = tokens
        ? {
            authenticated: true,
            token_expires_in_minutes: Math.floor((tokens.expires_at - Date.now()) / 60000),
            token_expired: Date.now() > tokens.expires_at,
          }
        : { authenticated: false };

      return {
        contents: [{ uri: uri.href, text: JSON.stringify(payload, null, 2) }],
      };
    }
  );

  server.registerResource(
    "safety-notice",
    "jobber://safety/notice",
    {
      title: "Safety Notice",
      description: "Plain-language notice about this connector's read-only scope",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text:
          "This connector is read-only in v1: it can look up and summarize data from your Jobber account, " +
          "but it cannot create, update, or delete anything in Jobber. No write actions are available. " +
          "Every tool call is logged to an append-only audit file on this machine at ~/.jobber-mcp/audit.log " +
          "(access tokens, secrets, and other credentials are never written to that file). Search terms and " +
          "other business data passed to tools may still appear there - client-identifying search terms are " +
          "hashed, not stored in plaintext, but treat the audit log itself as business-sensitive and restrict " +
          "access to this machine accordingly.",
      }],
    })
  );
}
