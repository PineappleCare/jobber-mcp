# PineappleCare Jobber MCP

An approval-gated MCP connector for Jobber, maintained by PineappleCare for
Williams Solutions. It is an MIT-licensed derivative of
[Adeocode's Jobber MCP](https://github.com/adeocode/jobber-mcp); upstream
attribution remains in [LICENSE](LICENSE).

## Safety model

- `JOBBER_READ_ONLY=true` is the default and registers no write tools.
- Writes require both `JOBBER_READ_ONLY=false` and a deliberate
  `JOBBER_WRITE_CAPABILITIES` allowlist: `records`, `scheduling`, and/or
  `communications`.
- Every write requires `confirm_write: true`, uses a fixed reviewed GraphQL
  operation, is audited with sensitive values hashed, and is never retried
  after an ambiguous result.
- The server never exposes raw GraphQL, payment, refund, delete, archive,
  bulk-mutation, webhook, expense, or timesheet tools.

The MCP host must require interactive approval for every write tool.

## Tools

The original reporting tools remain: client search/history, overdue invoices,
outstanding quotes, job and revenue summaries, schedule lookup, requests inbox,
and audit-log access.

Foundation reads are `search_records`, `get_record`, `catalog_search`, and
`team_list`. They cover clients, properties, requests, quotes, jobs, invoices,
visits, products/services, and assignable users.

With `records` enabled, the server provides client, property, request, draft
quote, job, and draft-invoice creation/update tools. With `scheduling`, it
provides visit creation/update/completion and reviewed job close/reopen. With
`communications`, it provides `mark_quote_sent` and `mark_invoice_sent`.
These record an external send in Jobber; they do not deliver email. Use a
separate approved mail tool for customer delivery.

## Local development

```bash
npm ci
npm run build
npm test
```

Set `JOBBER_CLIENT_ID` and `JOBBER_CLIENT_SECRET`, then ask the MCP host to run
`authenticate`. OAuth tokens are AES-256-GCM encrypted under
`JOBBER_STATE_DIR`, or `~/.jobber-mcp/` when that variable is unset. Container
deployments must mount `JOBBER_STATE_DIR` on persistent storage and provide a
stable `ENCRYPTION_KEY`. OAuth tokens and the audit log both live under that
directory. Never commit tokens, client secrets, or an `.env` file.

The included container image runs the authenticated streamable-HTTP transport.
Set `TRANSPORT=http`, `MCP_BASE_URL`, `MCP_API_KEY`, and `PORT`, and expose only
the `/mcp` endpoint to the intended MCP client. The image runs as an unprivileged
user and expects `JOBBER_STATE_DIR` to be a writable persistent mount.

`npm run schema:pull` downloads the currently configured Jobber GraphQL schema
using the encrypted local OAuth session and writes a versioned public schema
snapshot under `schema/`. Do not use Developer Center's Test in GraphiQL on a
live integration: Jobber says that flow invalidates its refresh token.

## Release checks

```bash
npm test
npm run lint
npm run build
npm run smoke
npm run schema:validate
npm run verify:version-sync
npm run verify:no-secrets
```

This repository is GitHub-source-only today. It deliberately has no MCP
registry `server.json` entry until the `@pineapplecare/jobber-mcp` package is
actually published.
