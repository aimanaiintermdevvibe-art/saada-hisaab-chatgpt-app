import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { dateRangeConditions } from "../src/db/time.js";
import { round2 } from "../src/tools/common.js";
import { connectAs, USER_A, USER_B, type Session } from "./helpers.js";

// A window covering all data, so independent SQL needs no time-zone handling.
const ALL = { from: "2000-01-01", to: "2100-12-31" };
let sessions: Session[];

async function scalar(sql: string, tenantId: string): Promise<number> {
  const { rows } = await pool.query<Record<string, unknown>>(sql, [tenantId]);
  return Number(Object.values(rows[0] ?? {})[0] ?? 0);
}

beforeAll(async () => {
  sessions = [await connectAs(USER_A), await connectAs(USER_B)];
});
afterAll(async () => {
  for (const s of sessions) await s.close();
  await pool.end();
});

describe("local-day date boundaries (Asia/Karachi, UTC+5)", () => {
  async function inside(utcTimestamp: string, from?: string, to?: string): Promise<boolean> {
    const values: unknown[] = [];
    const conds = dateRangeConditions("$1::timestamp", (v) => (values.push(v), `$${values.length + 1}`), from, to);
    const { rows } = await pool.query<{ ok: boolean }>(`SELECT (${conds.join(" AND ")}) AS ok`, [utcTimestamp, ...values]);
    return rows[0]!.ok;
  }

  it("19:30 UTC on Jan 1 is 00:30 on Jan 2 in Pakistan", async () => {
    expect(await inside("2026-01-01 19:30:00", "2026-01-02", "2026-01-02")).toBe(true);
    expect(await inside("2026-01-01 19:30:00", "2026-01-01", "2026-01-01")).toBe(false);
  });

  it("18:59 UTC is still the same local day; 19:00 UTC is the next", async () => {
    expect(await inside("2026-01-01 18:59:59", "2026-01-01", "2026-01-01")).toBe(true);
    expect(await inside("2026-01-01 19:00:00", "2026-01-01", "2026-01-01")).toBe(false);
  });
});

describe("accounting reports agree with independent SQL", () => {
  it("profit and loss net profit = income - expenses over all journal lines", async () => {
    for (const s of sessions) {
      const r = await s.call("get_profit_and_loss", ALL);
      const expected = await scalar(
        `SELECT sum(CASE a.type WHEN 'INCOME' THEN jl.credit - jl.debit ELSE -(jl.debit - jl.credit) END)
           FROM "JournalLine" jl JOIN "Account" a ON a.id = jl."accountId"
          WHERE jl."tenantId" = $1 AND a.type IN ('INCOME', 'EXPENSE')`,
        s.caller.tenantId,
      );
      expect(r.data.netProfit).toBeCloseTo(expected, 2);
      expect(r.data.grossProfit).toBeCloseTo(r.data.income.total - r.data.costOfGoodsSold.total, 2);
    }
  });

  it("trial balance and balance sheet are out by exactly the unbalanced journal entries", async () => {
    for (const s of sessions) {
      // Sum of (debit - credit) over all lines = 0 when every entry balances.
      const netDiff = round2(await scalar(`SELECT sum(debit - credit) FROM "JournalLine" WHERE "tenantId" = $1`, s.caller.tenantId));
      const tb = await s.call("get_trial_balance", { as_of: ALL.to });
      const bs = await s.call("get_balance_sheet", { as_of: ALL.to });
      expect(round2(tb.data.totalDebit - tb.data.totalCredit)).toBeCloseTo(netDiff, 2);
      expect(bs.data.difference).toBeCloseTo(netDiff, 2);
      if (netDiff !== 0) expect(bs.data.warning).toMatch(/do not balance/);
    }
  });

  it("cash ledger closing balance = cash balance", async () => {
    for (const s of sessions) {
      const ledger = await s.call("get_account_ledger", { account: "10101", ...ALL, limit: 1 });
      const cash = await s.call("get_cash_and_bank_balances", { as_of: ALL.to });
      expect(ledger.data.closingBalance).toBeCloseTo(cash.data.totalCash, 2);
    }
  });

  it("ledger running balance ends at the closing balance when nothing is truncated", async () => {
    const s = sessions[0]!;
    const r = await s.call("get_account_ledger", { account: "10101", ...ALL, limit: 500 });
    expect(r.data.truncated).toBe(false);
    expect(r.data.lines.at(-1).balance).toBeCloseTo(r.data.closingBalance, 2);
  });
});

describe("sales figures agree with independent SQL", () => {
  it("sales summary totals = completed, non-deleted invoices; monthly rows add up", async () => {
    for (const s of sessions) {
      const r = await s.call("get_sales_summary", { ...ALL, group_by: "month", limit: 100 });
      const expected = await scalar(
        `SELECT sum("netAmount") FROM "Invoice" WHERE "tenantId" = $1 AND NOT "isDeleted" AND status = 'COMPLETE'`,
        s.caller.tenantId,
      );
      expect(r.data.totals.netAmount).toBeCloseTo(expected, 2);
      const rowsTotal = r.data.rows.reduce((t: number, row: { netAmount: number }) => t + row.netAmount, 0);
      expect(rowsTotal).toBeCloseTo(expected, 2);
    }
  });

  it("outstanding balance = net amount - payments, for DUE invoices", async () => {
    for (const s of sessions) {
      const r = await s.call("get_outstanding_invoices", { kind: "sales", limit: 200 });
      const expected = await scalar(
        `SELECT sum(i."netAmount" - COALESCE((SELECT sum(amount) FROM "InvoicePaymentAllocation" a WHERE a."saleInvoiceId" = i.id), 0))
           FROM "Invoice" i
          WHERE i."tenantId" = $1 AND NOT i."isDeleted" AND i.status = 'COMPLETE' AND i."paymentStatus" = 'DUE'`,
        s.caller.tenantId,
      );
      expect(r.data.totalBalanceDue).toBeCloseTo(expected, 2);
    }
  });
});

describe("ledger and invoice lookups", () => {
  it("a truncated ledger shows the most recent lines with correct running balances", async () => {
    const s = sessions[0]!;
    const full = await s.call("get_account_ledger", { account: "10101", ...ALL, limit: 500 });
    const last5 = await s.call("get_account_ledger", { account: "10101", ...ALL, limit: 5 });
    expect(full.data.truncated).toBe(false);
    expect(last5.data.truncated).toBe(true);
    expect(last5.data.omittedEarlierLines).toBe(full.data.lineCount - 5);
    expect(last5.data.lines).toEqual(full.data.lines.slice(-5));
    expect(last5.data.lines.at(-1).balance).toBeCloseTo(last5.data.closingBalance, 2);
  });

  it("finds an invoice from a unique part of its number, and lists matches when ambiguous", async () => {
    const s = sessions[0]!;
    const count = async (part: string) =>
      scalar(`SELECT count(*) FROM "Invoice" WHERE "tenantId" = $1 AND NOT "isDeleted" AND "invoiceNumber" LIKE '%${part}%'`, s.caller.tenantId);
    const full = (
      await pool.query<{ n: string }>(
        `SELECT "invoiceNumber" AS n FROM "Invoice" WHERE "tenantId" = $1 AND NOT "isDeleted" ORDER BY "createdAt" DESC LIMIT 1`,
        [s.caller.tenantId],
      )
    ).rows[0]!.n;

    let unique = full;
    for (let len = 5; len < full.length; len++) {
      if ((await count(full.slice(-len))) === 1) {
        unique = full.slice(-len);
        break;
      }
    }
    const found = await s.call("get_sales_invoice", { invoice_number: unique });
    expect(found.isError, found.text).toBe(false);
    expect(found.data.invoice.invoiceNumber).toBe(full);

    const ambiguous = full.slice(0, 3);
    expect(await count(ambiguous)).toBeGreaterThan(1);
    const many = await s.call("get_sales_invoice", { invoice_number: ambiguous });
    expect(many.isError).toBe(true);
    expect(many.text).toMatch(/Several sales invoices contain/);
  });
});

describe("input handling", () => {
  it("rejects impossible dates and reversed ranges with a clear message", async () => {
    const s = sessions[0]!;
    const bad = await s.call("get_profit_and_loss", { from: "2026-02-30", to: "2026-03-01" });
    expect(bad.isError).toBe(true);
    const reversed = await s.call("get_profit_and_loss", { from: "2026-05-01", to: "2026-04-01" });
    expect(reversed.isError).toBe(true);
    expect(reversed.text).toMatch(/after the end date/);
  });

  it("asks to disambiguate when several accounts match", async () => {
    const r = await sessions[0]!.call("get_account_ledger", { account: "a" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Several accounts match/);
  });
});
