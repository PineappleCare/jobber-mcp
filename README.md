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

`list_notes` returns paginated, versioned notes for clients, requests, quotes,
jobs, and invoices. With `records` enabled, `create_note` and `update_note`
create or edit text, pinned state, and supported record links after approval.
They do not delete notes or add/remove attachments. Note writes verify ownership,
version, and readback and never substitute a job or visit instructions field.

With `records` enabled, the server provides client, property, request, draft
quote, job, and draft-invoice creation/update tools. With `scheduling`, it
provides visit creation/update/completion and reviewed job close/reopen.
Visit schedules use an explicit `mode`: `anytime` for a date without a time,
`timed` for exact start/end times, or `unscheduled` for no date. Use
`create_visits` to create 1-20 reviewed visits for one job in one mutation;
the result reports and verifies each visit separately. With
`communications`, it provides `mark_quote_sent` and `mark_invoice_sent`.
These record an external send in Jobber; they do not deliver email. Use a
separate approved mail tool for customer delivery.

`create_draft_invoice` accepts signed, nonzero quantities and nonnegative unit
prices. A separate named discount uses quantity `-1` and unit price `150` to
deduct $150; never net that discount into a charge or its description. Present
all lines and taxability for approval. `subject` is required for the bounded
duplicate scan (up to 500 client invoices); an incomplete scan blocks creation.
`tax_mode` defaults to `hst_13`: resolve an account-owned flat 13% HST rate and
make omitted line taxability explicitly true, including negative discounts.
Include `tax_mode` in the approval request. Only an explicit operator request
uses `tax_mode: none`, which makes omitted taxability false and requires every
line to be non-taxable. Prefer a 0% account rate when available; otherwise retain
a verified flat account rate with zero taxable lines. `tax_rate_id` may
disambiguate existing rates, but cannot select an incompatible rate. Missing or
ambiguous rates block creation; no tax settings are changed. Quote and job creation still require
positive quantities. The invoice stays unsent, and creation does not collect a
payment. A fresh invoice read verifies signed quantities, prices, line totals,
descriptions, taxability/product links, destination, draft status and the exact
due-date instant (equivalent timestamp offsets are accepted). It also verifies
the rate, exclusive tax calculation, subtotal, tax, total, balance and absence
of unrequested invoice-level discounts, deposits, payments and tips.
Only `outcome: created` confirms successful verified creation. Other outcomes
retain any returned invoice ID and require reconciliation before a newly
approved write; creation is never retried automatically. The existing guard
against another invoice on the source job remains in place.

`update_job_line_item_descriptions` (records capability) accepts a job ID,
its reviewed `expected_updated_at`, and up to 20 existing line-item IDs with
exact replacement descriptions. It checks membership through the job's own
paginated line-item connection (bounded at 500 lines), checks the version again,
and sends only IDs and descriptions through `jobEditLineItems`. Readback verifies
the descriptions and unchanged financial fields. Concurrent changes cannot be
locked atomically by this API; any partial, changed, or ambiguous result requires
reconciliation and a new approval. The mutation is never automatically retried.

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
