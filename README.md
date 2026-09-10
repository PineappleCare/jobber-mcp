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
`communications`, it provides `send_invoice` and a Jobber quote transition
tool. Jobber controls delivery to configured client contacts; no arbitrary
recipient field is accepted.

## Local development

```bash
npm ci
npm run build
npm test
```

Set `JOBBER_CLIENT_ID` and `JOBBER_CLIENT_SECRET`, then ask the MCP host to run
`authenticate`. OAuth tokens are AES-256-GCM encrypted under `~/.jobber-mcp/`.
Never commit tokens, client secrets, or an `.env` file.

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
npm run verify:version-sync
npm run verify:no-secrets
```

This repository is GitHub-source-only today. It deliberately has no MCP
registry `server.json` entry until the `@pineapplecare/jobber-mcp` package is
actually published.
