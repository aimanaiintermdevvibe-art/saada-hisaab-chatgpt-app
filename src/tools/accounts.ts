import { z } from "zod";
import { containsPattern, Params, type TenantDb } from "../db/tenant.js";
import { dateRangeConditions, localDateTime, todayLocal } from "../db/time.js";
import { CODES, loadAccounts, naturalBalance, under, type AccountRow, type Nature } from "./accounting-data.js";
import { checkRange, currency, fromDate, limit, refTypeLabel, round2, toDate } from "./common.js";
import { defineTool, ToolError } from "./framework.js";

const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"] as const;

const listAccounts = defineTool({
  name: "list_accounts",
  title: "List chart of accounts",
  description:
    "Lists the business's chart of accounts (account code, name, type, parent) with each account's balance " +
    "as of a date. Parent balances include their sub-accounts. Use it to find an account's code, to see " +
    "balances by account, or to answer 'what accounts do I have'. For one account's transactions use get_account_ledger.",
  input: {
    search: z.string().trim().min(1).max(100).optional().describe("Filter by account name or code (partial match)."),
    type: z.enum(ACCOUNT_TYPES).optional().describe("Only accounts of this type."),
    as_of: toDate("Balances as of this date. Defaults to today."),
    only_with_balance: z.boolean().default(false).describe("Only accounts whose balance is not zero."),
    include_inactive: z.boolean().default(false).describe("Include accounts marked inactive."),
  },
  async run(args, db) {
    const asOf = args.as_of ?? todayLocal();
    const all = await loadAccounts(db, { to: asOf });
    const needle = args.search?.toLowerCase();
    const rows = all
      .filter((a) => args.include_inactive || a.isActive)
      .filter((a) => !args.type || a.type === args.type)
      .filter((a) => !needle || a.name.toLowerCase().includes(needle) || a.code.includes(needle))
      .map((a) => ({
        code: a.code,
        name: a.name,
        type: a.type,
        normalSide: a.nature,
        parentCode: a.parentCode,
        level: a.codePath.length - 1,
        isPostingAccount: a.isLedger,
        isActive: a.isActive,
        balance: naturalBalance(a.nature, a.totalDebit, a.totalCredit),
      }))
      .filter((a) => !args.only_with_balance || a.balance !== 0);

    return {
      asOf,
      currency: currency(),
      count: rows.length,
      accounts: rows.slice(0, 300),
      truncated: rows.length > 300,
      note: "Balances are on each account's normal side; a negative balance means the opposite side.",
    };
  },
});

async function findAccount(db: TenantDb, text: string) {
  const matches = await db.query<{ id: string; code: string; name: string; type: string; nature: Nature }>(
    `SELECT id, code, name, type::text AS type, nature::text AS nature
       FROM "Account"
      WHERE "tenantId" = $1 AND (code = $2 OR name ILIKE $3)
      ORDER BY (code = $2) DESC, (lower(name) = lower($2)) DESC, code
      LIMIT 10`,
    [text, containsPattern(text)],
  );
  const exact = matches.find((m) => m.code === text || m.name.toLowerCase() === text.toLowerCase());
  if (exact) return exact;
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new ToolError(`No account matches "${text}". Use list_accounts to see account names and codes.`);
  const options = matches.map((m) => `${m.code} ${m.name}`).join("; ");
  throw new ToolError(`Several accounts match "${text}": ${options}. Ask which one, or pass its code.`);
}

const getAccountLedger = defineTool({
  name: "get_account_ledger",
  title: "Get account ledger",
  description:
    "Shows one account's ledger: opening balance, every journal line in the period with a running balance, " +
    "and the closing balance. Works for any account, e.g. Cash, a bank, a customer, a vendor, Sales, or Rent. " +
    "A parent account includes its sub-accounts. If there are more lines than `limit`, the most recent ones are " +
    "returned. Use it for 'show my cash book', 'recent bank transactions', 'transactions with customer X', " +
    "or 'how did this balance change'.",
  input: {
    account: z.string().trim().min(1).max(100).describe("Account code (e.g. 10101) or name (e.g. Cash, Meezan Bank)."),
    from: fromDate("Defaults to the start of the current year."),
    to: toDate("Defaults to today."),
    limit: limit(100, 500),
  },
  async run(args, db) {
    const from = args.from ?? `${todayLocal().slice(0, 4)}-01-01`;
    const to = args.to ?? todayLocal();
    checkRange(from, to);
    const account = await findAccount(db, args.account);

    // The account and its sub-accounts.
    const subtree = `WITH RECURSIVE sub AS (
        SELECT id, 0 AS depth FROM "Account" WHERE "tenantId" = $1 AND id = $2
        UNION ALL
        SELECT c.id, sub.depth + 1 FROM "Account" c JOIN sub ON c."parentId" = sub.id
         WHERE c."tenantId" = $1 AND sub.depth < 12)`;

    const totalsSql = (conds: string[]) => `${subtree}
      SELECT COALESCE(sum(jl.debit), 0) AS debit, COALESCE(sum(jl.credit), 0) AS credit, count(*) AS lines
        FROM "JournalLine" jl
        JOIN "JournalEntry" je ON je.id = jl."journalEntryId" AND je."tenantId" = $1
       WHERE jl."tenantId" = $1 AND jl."accountId" IN (SELECT id FROM sub) ${conds.map((c) => `AND ${c}`).join(" ")}`;

    // Opening balance: everything before `from`.
    const op = new Params();
    op.add(account.id);
    const [opening] = await db.query<{ debit: number; credit: number }>(
      totalsSql(dateRangeConditions('je."postedAt"', (v) => op.add(v), undefined, dayBefore(from))),
      op.values,
    );

    // Period totals.
    const pp = new Params();
    pp.add(account.id);
    const periodConds = dateRangeConditions('je."postedAt"', (v) => pp.add(v), from, to);
    const [period] = await db.query<{ debit: number; credit: number; lines: number }>(totalsSql(periodConds), pp.values);

    // Period lines: the most recent `limit` lines, shown oldest first. The running movement is
    // computed over the whole period, so balances stay correct when earlier lines are left out.
    // `delta` is one of two fixed SQL strings chosen by the account's normal side.
    const delta = account.nature === "DEBIT" ? "jl.debit - jl.credit" : "jl.credit - jl.debit";
    const lp = new Params();
    lp.add(account.id);
    const lineConds = dateRangeConditions('je."postedAt"', (v) => lp.add(v), from, to);
    const limitParam = lp.add(args.limit);
    const lines = await db.query<{
      date: string;
      refType: string;
      reference: string | null;
      narration: string;
      description: string | null;
      accountCode: string;
      accountName: string;
      debit: number;
      credit: number;
      movement: number;
    }>(
      `${subtree},
       lines AS (
         SELECT je.id AS "entryId", je."refId", je."postedAt", je."refType"::text AS "refType",
                je.narration, jl.description, a.code AS "accountCode", a.name AS "accountName", jl.debit, jl.credit,
                sum(${delta}) OVER w AS movement,
                row_number() OVER w AS seq
           FROM "JournalLine" jl
           JOIN "JournalEntry" je ON je.id = jl."journalEntryId" AND je."tenantId" = $1
           JOIN "Account" a ON a.id = jl."accountId" AND a."tenantId" = $1
          WHERE jl."tenantId" = $1 AND jl."accountId" IN (SELECT id FROM sub) ${lineConds.map((c) => `AND ${c}`).join(" ")}
         WINDOW w AS (ORDER BY je."postedAt", je.id, jl.id)
       ),
       latest AS (SELECT * FROM lines ORDER BY seq DESC LIMIT ${limitParam})
       SELECT ${localDateTime('l."postedAt"')} AS date, l."refType", ref.reference, l.narration, l.description,
              l."accountCode", l."accountName", l.debit, l.credit, l.movement
         FROM latest l
         LEFT JOIN LATERAL (
           SELECT COALESCE(
             (SELECT "invoiceNumber" FROM "Invoice" WHERE id = l."refId" AND "tenantId" = $1),
             (SELECT "invoiceNumber" FROM "PurchaseInvoice" WHERE id = l."refId" AND "tenantId" = $1),
             (SELECT "invoiceNumber" FROM "SaleReturn" WHERE id = l."refId" AND "tenantId" = $1),
             (SELECT "invoiceNumber" FROM "PurchaseReturn" WHERE id = l."refId" AND "tenantId" = $1),
             (SELECT "voucherNo" FROM "Voucher" WHERE (id = l."refId" OR "journalEntryId" = l."entryId") AND "tenantId" = $1 LIMIT 1),
             (SELECT "expenseNo" FROM "Expense" WHERE "journalEntryId" = l."entryId" AND "tenantId" = $1 LIMIT 1)
           ) AS reference
         ) ref ON true
        ORDER BY l.seq`,
      lp.values,
    );

    const openingBalance = naturalBalance(account.nature, opening?.debit ?? 0, opening?.credit ?? 0);
    const showAccount = lines.some((l) => l.accountCode !== account.code);
    const rows = lines.map((l) => ({
      date: l.date,
      type: refTypeLabel(l.refType),
      reference: l.reference,
      narration: l.description || l.narration,
      ...(showAccount ? { account: `${l.accountCode} ${l.accountName}` } : {}),
      debit: l.debit,
      credit: l.credit,
      balance: round2(openingBalance + l.movement),
    }));

    const periodDebit = period?.debit ?? 0;
    const periodCredit = period?.credit ?? 0;
    return {
      account: { code: account.code, name: account.name, type: account.type, normalSide: account.nature },
      period: { from, to },
      currency: currency(),
      openingBalance,
      totalDebit: round2(periodDebit),
      totalCredit: round2(periodCredit),
      closingBalance: round2(openingBalance + naturalBalance(account.nature, periodDebit, periodCredit)),
      lineCount: period?.lines ?? 0,
      lines: rows,
      truncated: (period?.lines ?? 0) > rows.length,
      ...((period?.lines ?? 0) > rows.length
        ? { omittedEarlierLines: (period?.lines ?? 0) - rows.length }
        : {}),
      note:
        "Balances are on the account's normal side; a negative balance means the opposite side. " +
        "When there are more lines than the limit, the most recent ones are shown.",
    };
  },
});

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function balancesUnder(accounts: AccountRow[], code: string) {
  return under(accounts, code)
    .filter((a) => !a.hasChildren)
    .map((a) => ({ id: a.id, code: a.code, name: a.name, balance: naturalBalance(a.nature, a.totalDebit, a.totalCredit) }));
}

const getCashAndBankBalances = defineTool({
  name: "get_cash_and_bank_balances",
  title: "Get cash and bank balances",
  description:
    "Returns how much money the business has: the balance of each cash account and each bank account " +
    "(bank name, account type, last 4 digits of the account number), with totals. Use it for " +
    "'how much cash do I have' or 'what's in my bank accounts'.",
  input: {
    as_of: toDate("Defaults to today."),
  },
  async run(args, db) {
    const asOf = args.as_of ?? todayLocal();
    const accounts = await loadAccounts(db, { to: asOf });
    const banks = await db.query<{ accountId: string; bankName: string; accountType: string | null; last4: string | null }>(
      `SELECT "accountId", name AS "bankName", "accountType"::text AS "accountType",
              NULLIF(right(regexp_replace(COALESCE("accountNumber", ''), '\\s', '', 'g'), 4), '') AS last4
         FROM "Bank" WHERE "tenantId" = $1 AND NOT "isDeleted"`,
    );
    const bankByAccount = new Map(banks.map((b) => [b.accountId, b]));

    const cash = balancesUnder(accounts, CODES.CASH).map(({ id: _id, ...rest }) => rest);
    const bankRows = balancesUnder(accounts, CODES.BANKS).map(({ id, ...rest }) => {
      const b = bankByAccount.get(id);
      return { ...rest, bankName: b?.bankName ?? rest.name, accountType: b?.accountType ?? null, accountNumberLast4: b?.last4 ?? null };
    });
    const totalCash = round2(cash.reduce((s, r) => s + r.balance, 0));
    const totalBank = round2(bankRows.reduce((s, r) => s + r.balance, 0));
    return {
      asOf,
      currency: currency(),
      cash,
      banks: bankRows,
      totalCash,
      totalBank,
      total: round2(totalCash + totalBank),
    };
  },
});

export const accountTools = [listAccounts, getAccountLedger, getCashAndBankBalances];
