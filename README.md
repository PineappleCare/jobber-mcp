# jobber-mcp

<!-- COPY: one-paragraph product pitch goes here -->

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for [Jobber](https://getjobber.com). It gives an MCP client (Claude Desktop, `mcp-remote`, etc.) tools to search clients, invoices, quotes, jobs, revenue, and schedule data from a connected Jobber account.

**v1 is read-only.** There are no write tools and no raw/passthrough GraphQL tool - every query is a fixed, reviewed document in `src/jobber/queries.ts`.

## Installation

```bash
npx -y @adeocode/jobber-mcp
```

Requires Node.js >= 18.

### Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "jobber": {
      "command": "npx",
      "args": ["-y", "@adeocode/jobber-mcp"],
      "env": {
        "JOBBER_CLIENT_ID": "your-jobber-client-id",
        "JOBBER_CLIENT_SECRET": "your-jobber-client-secret"
      }
    }
  }
}
```

On first use of any tool, the server opens your browser to complete Jobber's OAuth login. Tokens are encrypted at rest (AES-256-GCM) and stored under `~/.jobber-mcp/`.

### HTTP transport / `mcp-remote`

Set `TRANSPORT=http` and `MCP_BASE_URL` to the server's externally reachable URL, then point `mcp-remote` (or any StreamableHTTP-capable client) at `<MCP_BASE_URL>/mcp`. See [Configuration](#configuration) for the full HTTP env var list.

**Security for public hosting:** the server refuses to start in HTTP mode without `MCP_API_KEY` set (leaving it unset would expose `/mcp`, and everything it can read from Jobber, to anyone who can reach the port) - set `MCP_ALLOW_NO_API_KEY=true` to explicitly opt out, e.g. behind a trusted network or a reverse proxy that already enforces auth. `/mcp`, `/oauth/start`, and `/oauth/callback` also reject requests whose `Host`/`Origin` header doesn't match `MCP_BASE_URL` (or `MCP_ALLOWED_ORIGINS`), as DNS-rebinding protection. Use HTTPS for `MCP_BASE_URL` in any real deployment - the OAuth callback's binding cookie is only marked `Secure` when it is. Each session is bound to a hash of the `MCP_API_KEY` presented when it was created (so a leaked `mcp-session-id` alone, e.g. from a proxy log, can't be replayed without also presenting a valid key - this isn't per-tenant isolation, since `MCP_API_KEY` is one shared secret today) and is reaped after 30 minutes idle or 24 hours absolute, whichever comes first. `/health` reports `{ok: true}` only - it does not expose the current session count.

## Tools

All tools are read-only. `page_size` on list tools defaults to 20 and is capped per tool; requests above the cap are rejected.

| Tool | Description | Page cap |
|------|-------------|----------|
| `find_client` | Search clients by name, email, or phone. Returns contact info and addresses. | 20 |
| `client_history` | A client's jobs, quotes, invoices, and payments. | 20 |
| `overdue_invoices` | Unpaid invoices past due date, oldest first, total owed at the top. | 20 |
| `quotes_outstanding` | Sent quotes awaiting client response, with quote age and amounts. Excludes approved-but-not-yet-converted quotes. | 20 |
| `jobs_summary` | Jobs grouped by status over a date range, with counts and totals. | 20 |
| `revenue_summary` | Paid invoices grouped by month and quarter, with totals. | 20 |
| `schedule_lookup` | Visits and assessments for a date range, grouped by day. | 20 |
| `requests_inbox` | New and unscheduled requests, as two independently paginated sections. | 20 |
| `authenticate` | Trigger the Jobber OAuth login flow. | - |
| `auth_status` | Check authentication state and token expiry. | - |
| `logout` | Attempt to revoke the token at Jobber (best-effort) and clear local tokens. | - |
| `get_audit_log` | Read this server's own local audit log (date-filtered, paginated). Doesn't call Jobber. | - |

### Pagination

Every list tool accepts an optional `cursor` argument (on `client_history` this is split into `jobs_cursor`, `quotes_cursor`, `invoices_cursor`, and `payments_cursor`, one per section; on `requests_inbox` it's `cursor` for `new_requests` and `unscheduled_cursor` for `unscheduled_requests`). When a response has more records than fit on the current page, it includes both a `note` ("N more available") and a `next_cursor` value. Pass that value back in as `cursor` on your next call to fetch the following page - repeat until the response no longer includes a `next_cursor`.

`client_history`'s `payments_cursor` works differently from the other three: payments are nested per-invoice with no client-level connection, so passing `payments_cursor` (with `client_id`) fetches more payments for whichever invoice had more, instead of a fresh jobs/quotes/invoices page - that response contains only the `payments` section. Each payment item also carries `invoice_id`/`invoice_number` so it can be tied back to its invoice.

### Resources

| URI | Description |
|-----|-------------|
| `jobber://auth/status` | Current authentication status, as JSON. |
| `jobber://safety/notice` | Plain-language notice that this connector is read-only and where the audit log lives. |

## Cost table

<!--
Generated by `npm run build && npm run measure-costs` against a Jobber developer
account. Do NOT hand-type these numbers - re-run the script and paste its
Markdown table output here whenever a query changes.
-->

| tool | typical cost | max cost |
|------|--------------|----------|
| find_client | 334 | 500 |
| client_history | 27 | 50 |
| client_history (payments_cursor continuation) | 14-26 (varies with page fullness) | 26 |
| overdue_invoices | 186 | 250 |
| quotes_outstanding | 206 | 250 |
| jobs_summary | 66 | 400 |
| revenue_summary | 86 | 500 |
| schedule_lookup | 188 | 1200 |
| requests_inbox | 124 | 400 |

## Configuration

All variables are documented in [`.env.example`](.env.example). If you run the built server directly (`npm start`) rather than through an MCP client that passes env vars itself, `.env` is loaded from next to `package.json` (the installed package's own directory), not your current working directory - put it there, or export the variables in your shell instead.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JOBBER_CLIENT_ID` | yes | - | Jobber developer app client ID |
| `JOBBER_CLIENT_SECRET` | yes | - | Jobber developer app client secret |
| `JOBBER_REDIRECT_PORT` | no | `5679` | Local port for the stdio OAuth callback |
| `JOBBER_AUTH_URL` | no | `https://api.getjobber.com/api/oauth/authorize` | OAuth authorize endpoint |
| `JOBBER_TOKEN_URL` | no | `https://api.getjobber.com/api/oauth/token` | OAuth token endpoint |
| `JOBBER_GRAPHQL_URL` | no | `https://api.getjobber.com/api/graphql` | GraphQL endpoint; also used by `logout`'s best-effort `appDisconnect` revocation (Jobber has no separate REST revoke endpoint) |
| `JOBBER_GRAPHQL_VERSION` | no | `2025-04-16` | Pinned `X-JOBBER-GRAPHQL-VERSION`. Confirmed current/active in the Developer Center as of 2026-08-26 - recheck there before bumping |
| `ENCRYPTION_KEY` | no | auto-generated | 64-hex-char AES-256 key; overrides the OS keychain (useful for CI/headless installs) |
| `JOBBER_READ_ONLY` | no | `true` | Blocks any write tool from registering. v1 has no write tools regardless. |
| `TRANSPORT` | no | `stdio` | `stdio` or `http` |
| `MCP_BASE_URL` | required if `TRANSPORT=http` | - | Externally reachable base URL, used to build the OAuth redirect URI |
| `PORT` | no | `3000` | HTTP transport port |
| `MCP_API_KEY` | required if `TRANSPORT=http` (unless `MCP_ALLOW_NO_API_KEY=true`) | - | Required as a `Bearer` token on the `/mcp` endpoint. Leaving it unset exposes `/mcp` to anyone who can reach the port. |
| `MCP_ALLOW_NO_API_KEY` | no | - | Set to `true` to explicitly start HTTP mode without `MCP_API_KEY` (e.g. behind a trusted network or a reverse proxy that already enforces auth) |
| `MCP_ALLOWED_ORIGINS` | no | - | Comma-separated extra allowed `Origin` values for `/mcp`, `/oauth/start`, `/oauth/callback` - beyond the origin derived from `MCP_BASE_URL` (for a reverse proxy/CDN deployment) |

## Troubleshooting

**"API budget refilling, try again in Ns"** - Jobber uses cost-based rate limiting: every GraphQL call spends "points" from a 10,000-point budget that refills at 500 points/second. This server tracks that budget and automatically waits out short refills (5 seconds or less) before retrying. If Jobber returns `THROTTLED` (which can arrive as an HTTP 200 with a GraphQL error, not just an HTTP 429), the server waits and retries once automatically. You only see this error when the wait would be longer than 5 seconds - at that point the tool fails fast instead of hanging, and you can simply try again shortly.

**"Jobber restricts this data to accounts on its top-tier plan"** - Jobber gates full API access to its top plan. See [getjobber.com/pricing](https://getjobber.com/pricing/).

**OAuth loops back to an error page** - check that `JOBBER_CLIENT_ID`/`JOBBER_CLIENT_SECRET` match your Jobber developer app exactly, and (in HTTP mode) that `MCP_BASE_URL` matches the redirect URI registered with Jobber.

## Audit log

Every tool call is logged as JSONL to `~/.jobber-mcp/audit.log` (directory `0700`, file `0600`). Access tokens, refresh tokens, client secrets, passwords, and encryption keys are never written to this file - see `src/utils/auditLog.ts` for the redaction list. `find_client`'s `search_term` (which may contain a client's name, email, or phone number) is hashed rather than stored in plaintext, so it can be correlated across entries without exposing the underlying PII - but treat the audit log itself as business-sensitive and restrict access to this machine accordingly.

The log rotates once it crosses 10MB: the current file is renamed to `audit.log.1` (overwriting any prior rotation) and a fresh `audit.log` is started - single-generation rotation, not a full logrotate setup. Use the `get_audit_log` tool (date-filtered, paginated) to read it back; a response's `corrupted_lines` field (only present when nonzero) counts lines that failed to parse, e.g. from a write interrupted mid-line.

## Development

```bash
npm install
npm test
npm run build
npm run lint
```

GraphQL query verification: every document in `src/jobber/queries.ts` is marked `VERIFY-IN-GRAPHIQL` until it has been hand-checked against Jobber's Developer Center GraphiQL, pinned to `JOBBER_GRAPHQL_VERSION`. Do not remove that marker without doing the check. A full re-verification pass was completed 2026-08-26 covering every document, including `schedule_lookup` and `requests_inbox` after their pagination/timezone changes - no `VERIFY-IN-GRAPHIQL` markers currently remain.

## License

MIT
