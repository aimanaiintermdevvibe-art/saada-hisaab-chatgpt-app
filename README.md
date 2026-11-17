# Saada Hisaab for ChatGPT

A ChatGPT app that lets Saada Hisaab users ask questions about their own business in ChatGPT:
"How were sales last month?", "Who owes me money?", "Show my cash book", "Did I make a profit this year?".

It is an **MCP server** (Model Context Protocol, the protocol behind OpenAI's Apps SDK). ChatGPT calls its tools,
and the tools query the Saada Hisaab database, always scoped to the signed-in user's business (tenant).

**Phase 1 (this version): read-only.** No tool can create, change or delete data.

```
ChatGPT ──HTTPS / MCP──▶ this server (Node + TypeScript) ──read-only login──▶ PostgreSQL (sadahisab_db)
```

## Tenant isolation (how one business can never see another's data)

1. **Who is calling** is decided by the server, never by ChatGPT. Today that is the dev user in `.env`;
   in the OAuth phase it will be the user from the access token.
2. Every tool query goes through `withTenant()` ([src/db/tenant.ts](src/db/tenant.ts)): `$1` is always bound to
   the caller's tenant id, and any SQL that does not use `$1` is rejected before it runs.
3. Queries run in a **read-only transaction** as `sh_mcp_readonly`, a login that can only `SELECT`, cannot see
   password hashes, FBR API/terminal tokens or internal logs, and has a 15-second query limit.
4. Tests prove it: each tool returns exactly its own tenant's rows, and opening another tenant's invoice fails.

## Setup

Requires PostgreSQL 17 and Node 22+.

```powershell
copy .env.example .env          # then fill in PG_ADMIN_PASSWORD, DB_READONLY_PASSWORD, DEV_USERNAME, DEV_ACCESS_KEY
npm install
npm run db:setup -- -BackupPath C:\path\to\sh_db.backup   # creates the DB, restores it, creates the read-only login
npm test                         # 40 tests against the restored database
npm run dev                      # http://localhost:3000, MCP endpoint /mcp/<DEV_ACCESS_KEY>
```

`db:setup` never overwrites an existing database. To re-apply only the read-only login's permissions:
`npm run db:setup -- -RolesOnly`.

Random values for `DB_READONLY_PASSWORD` / `DEV_ACCESS_KEY`:
`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`

## Try it

- **MCP Inspector:** `npm run inspect`, choose *Streamable HTTP*, URL `http://localhost:3000/mcp/<DEV_ACCESS_KEY>`.
- **With an AI chat, no ChatGPT plan needed (Claude Code):** run `npm run dev`, then start a new Claude Code
  conversation in this folder and approve the `saada-hisaab` server from `.mcp.json`. Ask questions in plain English.
  `.mcp.json` holds the access key and is git-ignored. To recreate it, use this content with your key:
  `{"mcpServers":{"saada-hisaab":{"type":"http","url":"http://localhost:3000/mcp/<DEV_ACCESS_KEY>"}}}`
- **Inside ChatGPT (developer mode; needs ChatGPT Plus/Pro for read-only apps, or Business/Enterprise):**
  1. `npm run dev`, then in another terminal `ngrok http 3000`.
  2. Add the ngrok host (e.g. `abc123.ngrok-free.app`) to `ALLOWED_HOSTS` in `.env` and restart `npm run dev`.
  3. In ChatGPT settings, turn on **Developer mode**, create a new app/connector with URL
     `https://<ngrok-host>/mcp/<DEV_ACCESS_KEY>` and no authentication.
  4. In a new chat, enable the app and ask e.g. "What were my sales by month in 2026?".

  The access key in the URL is the only protection until OAuth exists. Keep the URL private and stop ngrok when done.

## Deploy (demo): Supabase + Render

Same code everywhere; only settings differ (`.env` locally, `.env.supabase` for the cloud database,
environment variables on Render).

1. **Database (Supabase):** create a project (region Singapore), copy the *Session pooler* details into
   `.env.supabase` (git-ignored), then restore:
   `.\db\setup-db.ps1 -EnvFile .env.supabase -BackupPath C:\path\to\sh_db.backup`.
   The script restores into the empty `postgres` database, creates the read-only login and removes the
   Supabase Data API's access (`anon`, `authenticated`) to the restored tables.
2. **Server (Render):** New > Blueprint > this repository. `render.yaml` defines the service; enter `PG_HOST`,
   `DB_READONLY_USER` and `DB_READONLY_PASSWORD` from `.env.supabase` when asked. Render generates
   `DEV_ACCESS_KEY` (see the service's Environment tab).
3. MCP endpoint: `https://<service>.onrender.com/mcp/<DEV_ACCESS_KEY>`. The free plan sleeps after 15 idle
   minutes; the first request then takes up to a minute.

Run the app locally against Supabase (PowerShell): `$env:ENV_FILE=".env.supabase"; npm run dev`.

## Tools

| Tool | Answers |
|---|---|
| `get_business_profile` | Business details, branches, user, and the date range that has data |
| `list_sales_invoices` | Find invoices by date, customer, payment/FBR status, amount |
| `get_sales_invoice` | One invoice with items, payments, returns, FBR status |
| `get_sales_summary` | Sales by day/week/month/customer/product/payment mode/branch |
| `list_purchase_invoices` | Find vendor bills |
| `get_purchase_invoice` | One bill with items and payments |
| `search_parties` | Customers/vendors with totals and outstanding amounts |
| `get_outstanding_invoices` | Receivables (who owes me) or payables (whom I owe), with age |
| `list_accounts` | Chart of accounts with balances |
| `get_account_ledger` | Any account's ledger with running balance |
| `get_cash_and_bank_balances` | Cash and bank balances |
| `get_trial_balance` | Trial balance |
| `get_profit_and_loss` | Income, COGS, gross profit, expenses, net profit |
| `get_balance_sheet` | Assets, liabilities, equity |
| `list_expenses` | Expense-module entries by account |
| `search_products` | Products, prices and stock on hand |

Sales tools count **invoices**; accounting reports use **journal entries**. They can differ (see
[docs/data-notes.md](docs/data-notes.md)), and each result says which basis it used.

## Project layout

```
db/setup-db.ps1            create DB, restore backup, create read-only login
db/sql/readonly-role.sql   read-only login and its permissions
src/index.ts               HTTP server (Express), access-key check, one MCP server per request
src/server.ts              MCP server: instructions for ChatGPT + tool registration
src/auth/caller.ts         who is calling -> tenant
src/db/                    pool, tenant guard (withTenant), time-zone helpers
src/tools/                 the tools, grouped by area
tests/                     smoke, tenant-isolation and accounting-correctness tests
docs/data-notes.md         data issues found in sh_db, for DevVibe
```

## Next steps

1. Test in ChatGPT developer mode with real questions; tune tool descriptions from what ChatGPT gets wrong.
2. OAuth 2.1 account linking (replaces `DEV_USERNAME` / `DEV_ACCESS_KEY`). Needs Saada Hisaab's login details.
3. Optional in-chat widgets (invoice, ledger, charts) with the Apps SDK.
4. Write tools (create invoice, record expense) with user confirmation, after DevVibe sign-off.
5. Deploy (HTTPS host, secrets, CI) and submit to the ChatGPT app directory.

Open questions for DevVibe: should cashiers see financial reports? Should users with a branch see only that branch?
