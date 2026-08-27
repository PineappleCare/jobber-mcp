# Jobber MCP Server: Connect Claude, ChatGPT or Copilot to Jobber

### Built by [Adeocode](https://www.adeocode.com/?utm_source=github&utm_medium=readme&utm_campaign=jobber-mcp&utm_content=top-byline): custom software for home service businesses

We build integrations and internal systems for HVAC, plumbing, roofing, coatings, fencing and landscaping companies, on top of the tools they already run. The client owns the code, including this connector. [Book a 15-minute call](https://www.adeocode.com/book?src=jobber-mcp&utm_source=github&utm_medium=readme&utm_campaign=jobber-mcp&utm_content=top-byline-call)

---

Open-source [Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude, ChatGPT or Microsoft Copilot read live data from [Jobber](https://getjobber.com): clients, jobs, quotes, invoices, revenue and the schedule. Ask the question in plain English and get the answer from your account, without exporting anything into a chat window.

**TL;DR:** 12 tools. Read-only, so it cannot change your account. Runs on your machine over stdio, or as a remote server over Streamable HTTP for ChatGPT and Copilot Studio. Budgets every query against Jobber's 10,000-point limit, which is the part most Jobber integrations get wrong. OAuth tokens encrypted at rest with AES-256-GCM. No relay server and no middleman. MIT licensed, free forever.

**Who this is for:** owners and office managers running a shop on Jobber, and the developers who build for them. If you can paste a block into a config file, you can use this.

> [!TIP]
> **Not a developer? You do not need to be.**
>
> The steps below assume someone comfortable editing a JSON file. If that is not you, we set it up for you: your own Jobber app, scoped credentials, and one person on your team walked through it.
>
> [See what we build on the Jobber API](https://www.adeocode.com/services/jobber-ai/?utm_source=github&utm_medium=readme&utm_campaign=jobber-mcp&utm_content=top-tip-svc) or [book a 15-minute call](https://www.adeocode.com/book?src=jobber-mcp&utm_source=github&utm_medium=readme&utm_campaign=jobber-mcp&utm_content=top-tip-call)

**Jump to:** [What you can ask it](#what-you-can-ask-it) . [Why this one is different](#why-this-one-is-different) . [Safety](#safety-what-it-can-and-cannot-do) . [Setup](#setup) . [Tools](#available-tools) . [Cost table](#cost-table) . [Need it built out?](#need-more-than-the-connector)

## What you can ask it

Once it is connected, these become one-line questions instead of nine clicks.

**Money**

- "Which invoices are past 30 days?"
- "How much are we owed right now?"
- "What did we bill last quarter?"
- "Show me revenue by month for this year"

**Quotes**

- "Which quotes went out and never came back?"
- "What is the oldest quote still waiting on a customer?"
- "How much is sitting in outstanding quotes?"

**Customers**

- "Pull up Harbour Coatings"
- "Summarize our history with this client"
- "What did we charge them last time?"
- "Find the contact with this phone number"

**Work**

- "What is on the schedule this week?"
- "How many jobs did we book last month, by status?"
- "Any new requests I have not looked at?"
- "What is unscheduled right now?"

Every answer comes from live Jobber data on each request. Nothing is cached, and nothing about your account is stored by the connector.

## Why this one is different

Jobber meters its API by **query cost**, not just by request count. You get 10,000 points. They refill at 500 points per second. A separate ceiling caps you at 2,500 requests every 5 minutes.

That matters more than it sounds. We build Jobber integrations in production, and we logged the cost of every call in one of them. **A single KPI dashboard load measured 13,456 to 20,762 points across 41 to 52 API calls.** One screen, against a 10,000-point budget.

Then there is the part that catches almost everyone. **When Jobber throttles you, it answers with HTTP 200 and puts the error in the response body.** Retry libraries key on status codes, read the 200 as success, and hand back nothing.

This connector is built around both facts:

- Every tool declares its maximum cost and checks the remaining budget **before** it spends anything.
- The throttle signal inside a 200 is detected, the refill is waited out, and the call is retried once.
- Page sizes are capped per tool, so one question cannot drain the bucket for the next one.
- If the wait would run long, it says so and fails fast instead of hanging.

The full measurements are public: [Jobber API rate limits, measured in production](https://www.adeocode.com/blog/jobber-api-rate-limits-what-you-can-actually-build/?utm_source=github&utm_medium=readme&utm_campaign=jobber-mcp&utm_content=mid-blog).

You can also read the [measured cost of every tool](#cost-table) below. Those numbers come from a script that runs each tool against a real account, not from an estimate.

## Safety: what it can and cannot do

**It is read-only.** Version 1 ships read tools only. It can look, count and summarize. It cannot create a job, send an invoice, or move a visit, so the worst failure is a wrong answer rather than a wrong action. Write tools will arrive one at a time, each behind an explicit approval step, each logged.

**The model never writes its own queries.** Every GraphQL document is fixed and reviewed in `src/jobber/queries.ts`. The model chooses which tool to call and what arguments to pass, and that is all. There is no raw query tool, which keeps both the access and the API cost predictable.

**Your credentials stay on your machine.** You register your own Jobber developer app. A Jobber account admin approves it through Jobber's own login page, so the connector never sees a password. Tokens are encrypted with AES-256-GCM at rest under `~/.jobber-mcp/`, and the key lives in your OS keychain rather than on disk in plaintext.

**Nothing routes through us.** The connector runs on your hardware and talks straight to Jobber. There is no Adeocode cloud service in the middle, because there is no cloud service at all.

**Every call is logged locally.** `~/.jobber-mcp/audit.log` records each tool call with a timestamp, the arguments, and the outcome. Tokens and secrets are never written to it, and `find_client`'s search term is hashed rather than stored, since it can contain a customer's name or phone number. Read it back with the `get_audit_log` tool.

**One honest limit.** The connector reads what Jobber's API exposes. Crew utilisation, hours by person, and cost or profit per job are not in there. Those need work beyond a connector, and that is covered at the bottom of this page.

## Requirements

- **Node.js 18 or later**: [nodejs.org/en/download](https://nodejs.org/en/download)
- **An MCP client**: [Claude Desktop](https://claude.ai/download), Claude Code, Cursor, ChatGPT (Developer mode) or Microsoft Copilot Studio
- **A Jobber account with API access**, and someone who can approve a developer app on it. Jobber gates full API access to its top plan, so check your plan first at [getjobber.com/pricing](https://getjobber.com/pricing/)

## Setup

Three steps, about fifteen minutes the first time.

### Step 1: Register a Jobber developer app

1. Go to [developer.getjobber.com](https://developer.getjobber.com) and sign in with a Jobber admin account.
2. Create a new app. Name it something you will recognise, for example `Claude Connector`.
3. Set the redirect URI to exactly `http://127.0.0.1:5679/callback`
4. Save, then copy the **Client ID** and **Client Secret**.

### Step 2: Add it to your AI client

**Claude Desktop.** Open your config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add this inside `mcpServers`, using your own values:

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

If other servers are already configured, add a comma after the last one before adding this block. Then quit Claude Desktop completely and reopen it.

**Claude Code:** `claude mcp add jobber -- npx -y @adeocode/jobber-mcp`

**Cursor:** same JSON block, in Cursor's MCP settings.

**ChatGPT and Microsoft Copilot Studio:** both connect to remote servers only, so use the HTTP transport below.

### Step 3: Sign in once

In a new conversation, say:

```
authenticate with Jobber
```

Your browser opens Jobber's login page. A Jobber admin approves the app. When it says the connection succeeded, go back to your assistant and try:

```
which invoices are past 30 days?
```

To check the connection later, ask for `auth_status`.

> [!TIP]
> **Stuck, or want it done properly the first time?**
>
> We register the app, wire it to your account, and walk one person on your team through it. Then we show you what it still cannot answer, which is usually the interesting part.
>
> [See the Jobber AI service](https://www.adeocode.com/services/jobber-ai/?utm_source=github&utm_medium=readme&utm_campaign=jobber-mcp&utm_content=mid-tip-svc) or [book a 15-minute call](https://www.adeocode.com/book?src=jobber-mcp&utm_source=github&utm_medium=readme&utm_campaign=jobber-mcp&utm_content=mid-tip-call)

### HTTP transport, for ChatGPT and Copilot Studio

ChatGPT's Developer mode and Microsoft Copilot Studio both require a server reachable over the internet, so run the connector in HTTP mode and point them at `<MCP_BASE_URL>/mcp`.

```bash
TRANSPORT=http \
MCP_BASE_URL=https://your-host.example.com \
MCP_API_KEY="$(openssl rand -hex 32)" \
JOBBER_CLIENT_ID=your-client-id \
JOBBER_CLIENT_SECRET=your-client-secret \
npx -y @adeocode/jobber-mcp
```

Read this before you expose it publicly. The server refuses to start in HTTP mode without `MCP_API_KEY`, because leaving it unset would open `/mcp`, and everything it can read from Jobber, to anyone who reaches the port. Set `MCP_ALLOW_NO_API_KEY=true` only when something else already enforces auth in front of it. `/mcp`, `/oauth/start` and `/oauth/callback` reject requests whose `Host` or `Origin` header does not match `MCP_BASE_URL`, as DNS-rebinding protection. Use HTTPS: the OAuth callback's binding cookie is only marked `Secure` when you do. Each session is bound to a hash of the API key presented when it was created, so a leaked `mcp-session-id` cannot be replayed on its own, and sessions are reaped after 30 minutes idle or 24 hours absolute. `/health` returns `{ok: true}` and nothing else.

## Available tools

Your assistant picks these automatically from the question. You never call them by name.

### Reading your account (8 tools)

| Tool | Inputs | What it does |
|---|---|---|
| `find_client` | `search_term`, `page_size`, `cursor` | Searches clients by name, email or phone. Returns contact details and addresses |
| `client_history` | `client_id`, per-section cursors | One client's jobs, quotes, invoices and payments |
| `overdue_invoices` | `page_size`, `cursor` | Unpaid invoices past their due date, oldest first, with the page total at the top |
| `quotes_outstanding` | `page_size`, `cursor` | Sent quotes still awaiting a customer response, with age and amounts |
| `jobs_summary` | `date_from`, `date_to`, `page_size` | Jobs grouped by status over a date range, with counts and totals |
| `revenue_summary` | `date_from`, `date_to`, `page_size` | Paid invoices grouped by month and quarter, with totals |
| `schedule_lookup` | `date_from`, `date_to`, `timezone` | Visits and assessments for a date range, grouped by day |
| `requests_inbox` | `page_size`, cursors | New and unscheduled requests, as two separately paged sections |

### Managing the connection (4 tools)

| Tool | What it does |
|---|---|
| `authenticate` | Opens Jobber's login page and stores the approved credentials, encrypted |
| `auth_status` | Whether it is connected, and when the token expires |
| `logout` | Revokes at Jobber where possible, then clears the local tokens |
| `get_audit_log` | Reads this server's own log of every call it has made, date-filtered and paginated |

### Resources

| URI | What it contains |
|---|---|
| `jobber://auth/status` | Live authentication state as JSON |
| `jobber://safety/notice` | Plain-language notice that this connector is read-only, and where the audit log lives |

### Pagination

Every list tool takes an optional `cursor`. When more records exist than fit on a page, the response carries both a `note` ("N more available") and a `next_cursor`. Pass that value back as `cursor` on the next call, and repeat until no `next_cursor` comes back.

`client_history` splits this into `jobs_cursor`, `quotes_cursor`, `invoices_cursor` and `payments_cursor`, one per section, and `requests_inbox` uses `cursor` for new requests and `unscheduled_cursor` for unscheduled ones. `payments_cursor` behaves differently from the others: payments are nested per invoice with no client-level connection, so passing it fetches more payments for whichever invoice had more, and that response contains only the `payments` section. Each payment carries `invoice_id` and `invoice_number` so it ties back.

## Cost table

Measured, not estimated. Generated by running each tool against a real Jobber account with per-call cost logging, against the 10,000-point budget described above.

| Tool | Typical cost | Max cost |
|---|---|---|
| `find_client` | 334 | 500 |
| `client_history` | 27 | 50 |
| `client_history` (payments continuation) | 14-26 | 26 |
| `overdue_invoices` | 186 | 250 |
| `quotes_outstanding` | 206 | 250 |
| `jobs_summary` | 66 | 400 |
| `revenue_summary` | 86 | 500 |
| `schedule_lookup` | 188 | 1200 |
| `requests_inbox` | 124 | 400 |

Regenerate with `npm run build && npm run measure-costs`. Do not hand-type these.

## Configuration

Every variable is documented in [`.env.example`](.env.example). If you run the built server directly with `npm start` rather than through a client that passes env vars itself, `.env` is read from next to `package.json` in the installed package directory, not from your working directory. Put it there, or export the variables in your shell.

| Variable | Required | Default | Description |
|---|---|---|---|
| `JOBBER_CLIENT_ID` | yes | - | Jobber developer app client ID |
| `JOBBER_CLIENT_SECRET` | yes | - | Jobber developer app client secret |
| `JOBBER_REDIRECT_PORT` | no | `5679` | Local port for the stdio OAuth callback |
| `JOBBER_AUTH_URL` | no | Jobber's authorize endpoint | OAuth authorize endpoint override |
| `JOBBER_TOKEN_URL` | no | Jobber's token endpoint | OAuth token endpoint override |
| `JOBBER_GRAPHQL_URL` | no | Jobber's GraphQL endpoint | Also used by `logout`'s best-effort revocation, since Jobber has no separate revoke endpoint |
| `JOBBER_GRAPHQL_VERSION` | no | `2025-04-16` | Pinned `X-JOBBER-GRAPHQL-VERSION`. Confirmed active in the Developer Center as of 2026-08-26. Recheck there before bumping |
| `ENCRYPTION_KEY` | no | auto-generated | 64-hex-char AES-256 key, overriding the OS keychain. For CI and headless installs |
| `JOBBER_READ_ONLY` | no | `true` | Blocks any write tool from registering. Version 1 has no write tools regardless |
| `TRANSPORT` | no | `stdio` | `stdio` or `http` |
| `MCP_BASE_URL` | in HTTP mode | - | Externally reachable base URL, used to build the OAuth redirect URI |
| `PORT` | no | `3000` | HTTP transport port |
| `MCP_API_KEY` | in HTTP mode | - | Bearer token required on `/mcp`. The server refuses to start without it unless you opt out below |
| `MCP_ALLOW_NO_API_KEY` | no | - | `true` starts HTTP mode without a key. Only behind something that already enforces auth |
| `MCP_ALLOWED_ORIGINS` | no | - | Comma-separated extra allowed `Origin` values, for a reverse proxy or CDN deployment |

## Troubleshooting

**"API budget refilling, try again in Ns."** Jobber's cost-based rate limiting is doing its job. The connector tracks the budget and waits out short refills of 5 seconds or less automatically, including the `THROTTLED` response Jobber sends inside an HTTP 200. You only see this message when the wait would run longer than that, at which point it fails fast rather than hanging. Try again shortly.

**"Jobber restricts this data to accounts on its top-tier plan."** Jobber gates full API access to its top plan. Check yours at [getjobber.com/pricing](https://getjobber.com/pricing/).

**OAuth loops back to an error page.** Check that `JOBBER_CLIENT_ID` and `JOBBER_CLIENT_SECRET` match your developer app exactly, and that the redirect URI registered with Jobber matches the one the connector uses. In HTTP mode it is derived from `MCP_BASE_URL`.

**Port 5679 is already in use.** Set `JOBBER_REDIRECT_PORT` to a free port, and update the redirect URI on your Jobber app to match.

**"Token file exists but decryption failed."** The encryption key no longer matches the one that wrote the token file, usually because the keychain entry was removed, the machine changed, or `ENCRYPTION_KEY` was set differently. Run `logout`, then `authenticate` again.

## Audit log

Every tool call is written as JSONL to `~/.jobber-mcp/audit.log`, with the directory at `0700` and the file at `0600`. Access tokens, refresh tokens, client secrets, passwords and encryption keys are never written to it. See `src/utils/auditLog.ts` for the redaction list. `find_client`'s `search_term` is hashed rather than stored in plaintext, so it can be correlated across entries without exposing a customer's name, email or phone. Treat the log as business-sensitive and restrict access to the machine accordingly.

The file rotates once past 10MB: the current one becomes `audit.log.1`, overwriting any previous rotation, and a fresh log starts. That is single-generation rotation, not a full logrotate setup. Read it back with the `get_audit_log` tool. A `corrupted_lines` count appears in the response when any line failed to parse, for example from a write interrupted mid-line.

## Need more than the connector?

This connector reads your Jobber account. It does not build anything on top of that data, and the questions owners care about most often sit just outside what the API exposes: crew utilisation, hours by person, cost and profit per job, or a dashboard that stays fast because it syncs into its own database in the background.

That is the work we do. [See what we build on the Jobber API](https://www.adeocode.com/services/jobber-ai/?utm_source=github&utm_medium=readme&utm_campaign=jobber-mcp&utm_content=footer-svc-jobber-ai), read the [overview with the full tool list and FAQ](https://www.adeocode.com/jobber-mcp/?utm_source=github&utm_medium=readme&utm_campaign=jobber-mcp&utm_content=footer-hub), or [book a 15-minute call](https://www.adeocode.com/book?src=jobber-mcp&utm_source=github&utm_medium=readme&utm_campaign=jobber-mcp&utm_content=footer-call) and bring the question you most wish Jobber could answer. If a Zap covers it, you will hear that first.

## Free forever

**The code in this repository stays MIT, and new releases of it stay MIT.** Nothing here is crippled, time-limited, or held back for a paid tier. We make our money building the systems this cannot build.

## Supporting this project

We do not take donations. If it saved you time, the things that genuinely help:

- **Star the repo.** It is how other shops find it.
- **Tell another shop running Jobber.**
- **Open an issue** when you hit a Jobber API case this handles badly.

## Who we are

[Adeocode](https://www.adeocode.com/?utm_source=github&utm_medium=readme&utm_campaign=jobber-mcp&utm_content=who-we-are) builds custom software for home service businesses: HVAC, plumbing, roofing, coatings, fencing, landscaping and the trades around them. Integrations, dashboards, and internal systems built around how a shop already works, owned outright by the client.

We are independent builders. We are not affiliated with Jobber, Housecall Pro, ServiceTitan or Anthropic, and we take no referral fee from any of them. Everything we publish about their products carries the date we verified it.

- Web: [adeocode.com](https://www.adeocode.com/?utm_source=github&utm_medium=readme&utm_campaign=jobber-mcp&utm_content=who-we-are-web)
- Book a call: [15 minutes with a founder](https://www.adeocode.com/book?src=jobber-mcp&utm_source=github&utm_medium=readme&utm_campaign=jobber-mcp&utm_content=who-we-are-call)

## Contributing

Issues and pull requests are welcome. If you hit a Jobber API edge case this handles badly, open an issue with the scenario and an example request. Read-only tools that fit the version 1 scope are welcome as pull requests.

## Development

```bash
npm install
npm test
npm run build
npm run lint
```

Every GraphQL document in `src/jobber/queries.ts` is verified against Jobber's Developer Center GraphiQL at the pinned `JOBBER_GRAPHQL_VERSION` before it ships. A full re-verification pass covering every document was completed 2026-08-26, including `schedule_lookup` and `requests_inbox` after their pagination and timezone changes. No `VERIFY-IN-GRAPHIQL` markers remain.

## License

MIT (c) Adeocode. See [LICENSE](LICENSE).
