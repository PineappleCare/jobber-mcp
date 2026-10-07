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

`list_tasks` and `get_task` expose native tasks with schedules, assignments,
links and a content-derived `task_version`. The `scheduling` capability enables
approval-required `create_task` and `update_task` for non-recurring tasks. Use
explicit anytime (all-day), timed or unscheduled schedules; timezone defaults to
America/Toronto. Optional client/property links are checked against this account.
Assignment emails require `notify_team: true` (default false); they are not SMS
and delivery is not verified. Timed assigned tasks may request a supported team
reminder. Updates require `expected_task_version`, preserve omitted fields and
reject completed/recurring tasks. No task deletion, completion or recurrence
editing is exposed. Creation scans for identical tasks, blocks incomplete scans,
and never retries an ambiguous mutation. Returned IDs remain available when
readback fails or Jobber reports partial errors.

Job reads include `jobType`. `create_job` now defaults to `job_type: ONE_OFF`
and blocks before writing because the reviewed live API has no verified one-off
creation selector. An explicit `RECURRING` choice is required for the existing
recurring/as-needed API path, with fresh type readback. Fixed-price billing is
not proof of a one-off job. Never substitute a recurring job or task for a
requested one-off job, and never claim conversion of an existing job.

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
stable vault-supplied `ENCRYPTION_KEY`. Managed state fails closed without it;
keys supplied through the environment are never copied into OS Keychain. OAuth tokens and the audit log both live under that
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

## Private Williams voice API

The optional HTTP surface is separate from staff MCP tools and approvals. Enable
with `JOBBER_VOICE_ENABLED=true`, `JOBBER_VOICE_API_KEY` (at least 32 characters,
different from `MCP_API_KEY`), `JOBBER_VOICE_ACCOUNT_ID`, `JOBBER_STATE_DIR` and
vault-supplied `ENCRYPTION_KEY`. Requires Node 22.13 or newer (`node:sqlite`);
the pinned container runtime supports it. Keep the port on loopback/Tailscale,
never a public ingress. The voice credential cannot authenticate MCP requests.

`POST /voice/v1/execute` accepts these fixed actions with `call_id` and original
`caller_number`: `resolve`, `status`, `prepare`, `submit`, `message`, and
`operation_status`. Ermine supplies identity from signed active inbound call state;
this is a trusted service interface, not a browser/customer endpoint. The
connector verifies the configured account before any action, and again before
external mutations. It never accepts arbitrary GraphQL or a tenant selector.
See [the Ermine release contract](https://github.com/PineappleCare/ermine/blob/master/docs/WILLIAMS_JOBBER_VOICE.md)
for the intake shape, deployment order and acceptance procedure.

`submit`/`message` require caller confirmation and a UUID `operation_id`. Bind the
ID to the full immutable payload and call. The SQLite journal in
`JOBBER_STATE_DIR/voice-operations.db` records dispatch before every mutation,
returned IDs and verified readbacks. Retries return the recorded result. Uncertain
writes are reconciled through reads; verified steps may resume undispatched work.
Missing evidence remains uncertain for staff review, with no blind mutation replay.
This is not an exactly-once claim across network or process failures.

New work creates a Request and intake Note, then an Assessment only with a known
property. Assessments have no start/end time, assigned users or team notification.
Scheduling preferences remain in the Note. No Jobs, Visits, appointments, prices,
status changes or customer notifications are created by this surface. Optional
email, single names and incomplete locations are preserved without invented fields.

`GET /voice/v1/health` requires the voice bearer and returns only aggregate
operation outcome counts. `scripts/voice-fixture.mjs` is a loopback-only fake
Jobber backend for Ermine's opt-in cross-repository test; it isolates all audit and
OAuth state from the developer's home directory and Keychain. Mock verification
and schema validation do not replace testing scopes and writes on a Jobber test account.

Voice HTTP dispatch returns completed results or durable pending IDs within two
seconds. A background worker resumes pending/uncertain operations from the journal;
safe prerequisite read failures remain pending instead of becoming permanent write
failures. Read-only resolve/status operations are also journaled and freshly
reauthorized when polled. Per-operation scan checkpoints preserve completed pages.
The complete, account-scoped SQLite phone directory refreshes in the background,
including property-level contacts. It provides discovery candidates only; phone,
record membership and property restrictions are reread before disclosure/writes.
An index miss never authorizes new-client creation: complete duplicate checks still
run before creation. `/voice/v1/health` includes directory completeness, refresh and
failure timestamps. All new tables are additive and must survive rollback.

Completed reads remain in the journal when polled. Delivery rechecks account,
caller phones, property restrictions and selected record membership; it does not
restart full discovery. Slow authorization has one in-flight check and a one-use
handoff expiring after two seconds. Pending replies include `retry_at`; callers
must poll promptly to consume a completed check. Expired checks and process
restarts require fresh authorization.

Schema rejection returns `failed` / `invalid_input` with `invalid_fields`.
`submission_rejected: true` is returned only when the operation ID never entered
the connector journal. Existing IDs cannot use that marker to bypass recovery.
Explicit mutation validation errors with no returned record are stored as
`rejected` steps and settle as failed/partial with error details. Transport loss,
missing responses and top-level execution errors retain uncertainty. Rejected
steps survive restarts and are never redispatched. Index account-check failures
are included in refresh health reporting.
