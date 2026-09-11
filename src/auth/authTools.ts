import { McpServer } from "@modelcontextprotocol/server";
import { clearTokens, loadTokens } from "./tokenStorage.js";
import { getValidAccessToken, buildAuthorizationUrl, revokeToken } from "./oauth.js";
import { appendAuditLog } from "../utils/auditLog.js";
import { requireSessionContext } from "../utils/sessionContext.js";

export function registerAuthTools(server: McpServer): void {
  server.registerTool(
    "auth_status",
    { description: "Check whether the connector is authenticated with Jobber and when the token expires" },
    async () => {
      const ctx = requireSessionContext();
      let tokens = ctx ? ctx.getTokens() : await loadTokens();

      if (!tokens) {
        await appendAuditLog({ tool: "auth_status", args: {}, outcome: "success" });
        return {
          content: [{ type: "text", text: JSON.stringify({ authenticated: false }) }],
        };
      }

      // Checking status should use the same refresh path as an API call. Otherwise a healthy
      // connection is reported as expired as soon as its short-lived access token ages out, even
      // though its refresh token is still valid and the next API call would succeed.
      if (Date.now() > tokens.expires_at - 5 * 60 * 1000) {
        const previousAccountId = tokens.account_id;
        const previousExpiry = tokens.expires_at;
        try {
          if (ctx) {
            await ctx.getAccessToken();
            tokens = ctx.getTokens();
          } else {
            await getValidAccessToken();
            tokens = await loadTokens();
          }
        } catch {
          await appendAuditLog({
            tool: "auth_status",
            args: {},
            outcome: "error",
            account_id: previousAccountId,
            error_message: "Token refresh failed",
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                authenticated: false,
                token_expired: Date.now() >= previousExpiry,
                refresh_failed: true,
                warning: "Token refresh failed. Run the 'authenticate' tool to reconnect Jobber.",
              }),
            }],
            isError: true,
          };
        }
      }

      if (!tokens) {
        await appendAuditLog({
          tool: "auth_status",
          args: {},
          outcome: "error",
          error_message: "Token state unavailable after refresh",
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ authenticated: false }) }],
          isError: true,
        };
      }

      await appendAuditLog({
        tool: "auth_status",
        args: {},
        outcome: "success",
        account_id: tokens.account_id,
      });

      const expiresIn = Math.floor((tokens.expires_at - Date.now()) / 1000 / 60);
      const token_expired = expiresIn < 0;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            authenticated: true,
            token_expires_in_minutes: expiresIn,
            token_expired,
            ...(token_expired && { warning: "Token has expired. Run the 'authenticate' tool to refresh." }),
          }),
        }],
      };
    }
  );

  server.registerTool(
    "authenticate",
    { description: "Trigger the Jobber OAuth login flow" },
    async () => {
      const ctx = requireSessionContext();
      if (ctx) {
        // HTTP mode: return a URL for the user to visit in their browser. The link points at this
        // server's own /oauth/start (not the raw Jobber authorize URL) so the browser touches this
        // server once before ever reaching Jobber - that request is what lets /oauth/start plant a
        // binding cookie, which /oauth/callback later requires in addition to the state-embedded
        // nonce. Without that touchpoint, an attacker with their own valid code/state pair could
        // otherwise complete the callback against a victim's session (login CSRF).
        try {
          const { url, nonce, codeVerifier, state } = buildAuthorizationUrl(ctx.sessionId);
          ctx.setPendingNonce(nonce);
          ctx.setPendingCodeVerifier(codeVerifier);
          ctx.setPendingAuthorizeUrl(url);
          const baseUrl = (process.env.MCP_BASE_URL ?? "").trim();
          const startUrl = `${baseUrl}/oauth/start?state=${encodeURIComponent(state)}`;
          await appendAuditLog({ tool: "authenticate", args: {}, outcome: "success" });
          return {
            content: [{
              type: "text",
              text: `Please authenticate by visiting this URL:\n\n${startUrl}\n\nAfter completing login in your browser, return here and call any Jobber tool.`,
            }],
          };
        } catch (err: any) {
          await appendAuditLog({ tool: "authenticate", args: {}, outcome: "error", error_message: err.message });
          return {
            content: [{ type: "text", text: `❌ Error: ${err.message}` }],
            isError: true,
          };
        }
      }

      // stdio mode: run browser-based OAuth flow
      try {
        await getValidAccessToken();
        await appendAuditLog({ tool: "authenticate", args: {}, outcome: "success" });
        return {
          content: [{ type: "text", text: "✅ Successfully authenticated with Jobber!" }],
        };
      } catch (err: any) {
        await appendAuditLog({ tool: "authenticate", args: {}, outcome: "error", error_message: err.message });
        return {
          content: [{ type: "text", text: `❌ Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "logout",
    {
      description:
        "Log out of Jobber. Attempts to revoke the access token at Jobber via the appDisconnect " +
        "mutation (best-effort - local tokens are always cleared even if remote revocation fails).",
    },
    async () => {
      const ctx = requireSessionContext();
      try {
        const tokens = ctx ? ctx.getTokens() : await loadTokens();
        if (tokens?.access_token) {
          // revokeToken (oauth.ts) is documented never to throw, but local tokens must clear even
          // if that contract is ever broken - revocation at Jobber is a courtesy, not a precondition.
          await revokeToken(tokens.access_token).catch(() => {});
        }
        if (ctx) {
          ctx.clearTokens();
        } else {
          await clearTokens();
        }
        await appendAuditLog({ tool: "logout", args: {}, outcome: "success", account_id: tokens?.account_id });
        return {
          content: [{ type: "text", text: "✅ Logged out. Tokens cleared (revocation at Jobber attempted)." }],
        };
      } catch (err: any) {
        await appendAuditLog({ tool: "logout", args: {}, outcome: "error", error_message: err.message });
        return {
          content: [{ type: "text", text: `❌ Logout failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
