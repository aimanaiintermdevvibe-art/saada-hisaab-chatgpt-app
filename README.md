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

1. **Who is calling** comes from the OAuth access token the user got by signing in, never from ChatGPT's
   tool arguments. The token names the Saada Hisaab user; the server looks up that user's tenant.
2. Every tool query goes through `withTenant()` ([src/db/tenant.ts](src/db/tenant.ts)): `$1` is always bound to
   the caller's tenant id, and any SQL that does not use `$1` is rejected before it runs.
3. Queries run in a **read-only transaction** as `sh_mcp_readonly`, a login that can only `SELECT`, cannot see
   password hashes, FBR API/terminal tokens or internal logs, and has a 15-second query limit.
4. Tests prove it: each tool returns exactly its own tenant's rows, and opening another tenant's invoice fails.

## Setup

Requires PostgreSQL 17 and Node 22+.

```powershell
copy .env.example .env          # then fill in the passwords, OAUTH_SECRET and DEV_LOGIN_PASSWORD
npm install
npm run db:setup -- -BackupPath C:\path\to\sh_db.backup   # creates the DB, restores it, creates the read-only login
npm test                         # 60 tests against the restored database (incl. the full OAuth flow)
npm run dev                      # http://localhost:3000, MCP endpoint /mcp (sign-in required)
```

`db:setup` never overwrites an existing database. To re-apply only the read-only login's permissions:
`npm run db:setup -- -RolesOnly`.

Random values for `DB_READONLY_PASSWORD`, `OAUTH_SECRET`, `DEV_ACCESS_KEY`:
`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`

## Sign-in (OAuth 2.1)

ChatGPT never sees the user's password or the Saada Hisaab login API. The server is its own OAuth
authorization server ([src/auth/oauth-provider.ts](src/auth/oauth-provider.ts)):

1. ChatGPT reads `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`,
   then registers itself (`/register`, dynamic client registration).
2. The user clicks Connect and lands on our `/authorize` page: **Sign in to Saada Hisaab**.
3. `/login` checks the username and password (dev: `DEV_LOGIN_PASSWORD`; api: Saada Hisaab login API),
   then sends the browser back to ChatGPT with a one-time code.
4. ChatGPT exchanges the code (PKCE S256) at `/token` for a 1-hour access token and a 30-day refresh token.
5. Every `/mcp` request needs the access token; the server resolves the user and their tenant from it.

Everything is a signed token (`OAUTH_SECRET`), so registrations and sign-ins survive restarts and Render's sleep.
Redirect targets are limited to `OAUTH_REDIRECT_HOSTS` (default: chatgpt.com, claude.ai, localhost).

**Sign-in modes** (`LOGIN_MODE`):
- `dev` (now): any Saada Hisaab username (e.g. `admin`, `abc123`) with the shared `DEV_LOGIN_PASSWORD`. Dummy data only.
- `api`: set `SAADA_LOGIN_API_URL`. The request/response mapping in [src/auth/login.ts](src/auth/login.ts) is
  assumed (POST `{username, password}`, 2xx = valid) until DevVibe shares the API spec.

## Try it

- **MCP Inspector:** `npm run inspect`, choose *Streamable HTTP*, URL `http://localhost:3000/mcp`, and use its
  OAuth settings to sign in (or use the dev shortcut URL below without sign-in).
- **With an AI chat, no ChatGPT plan needed (Claude Code):** run `npm run dev`, then start a new Claude Code
  conversation in this folder and approve the `saada-hisaab` server from `.mcp.json`. Ask questions in plain English.
  This uses the **dev shortcut** `/mcp/<DEV_ACCESS_KEY>` (no sign-in; acts as `DEV_USERNAME`). `.mcp.json` holds
  the key and is git-ignored. To recreate it:
  `{"mcpServers":{"saada-hisaab":{"type":"http","url":"http://localhost:3000/mcp/<DEV_ACCESS_KEY>"}}}`
- **Inside ChatGPT (developer mode):** use the deployed server (below). In ChatGPT settings, turn on
  **Developer mode**, create an app with URL `https://<service>.onrender.com/mcp` and authentication **OAuth**.
  ChatGPT registers itself; click Connect and sign in with a Saada Hisaab username and the demo password.

## Deploy (demo): Supabase + Render

Same code everywhere; only settings differ (`.env` locally, `.env.supabase` for the cloud database,
environment variables on Render).

1. **Database (Supabase):** create a project (region Singapore), copy the *Session pooler* details into
   `.env.supabase` (git-ignored), then restore:
   `.\db\setup-db.ps1 -EnvFile .env.supabase -BackupPath C:\path\to\sh_db.backup`.
   The script restores into the empty `postgres` database, creates the read-only login and removes the
   Supabase Data API's access (`anon`, `authenticated`) to the restored tables.
2. **Server (Render):** New > Blueprint > this repository. `render.yaml` defines the service; enter `PG_HOST`,
   `DB_READONLY_USER`, `DB_READONLY_PASSWORD` and `DEV_LOGIN_PASSWORD` from `.env.supabase` when asked.
   Render generates `OAUTH_SECRET` and `DEV_ACCESS_KEY`; the public URL (OAuth issuer) comes from Render.
3. MCP endpoint: `https://<service>.onrender.com/mcp` (OAuth sign-in). The free plan sleeps after 15 idle
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
