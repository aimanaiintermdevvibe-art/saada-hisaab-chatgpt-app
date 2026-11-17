import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { connectAs, USER_A, type Session } from "./helpers.js";

// Data in sh_db runs from 2025-10 to 2026-08; use a fixed window so results do not depend on today's date.
const FROM = "2025-10-01";
const TO = "2026-08-31";

const CALLS: [string, Record<string, unknown>][] = [
  ["get_business_profile", {}],
  ["list_sales_invoices", { from: FROM, to: TO }],
  ["get_sales_summary", { from: FROM, to: TO, group_by: "month" }],
  ["get_sales_summary", { from: FROM, to: TO, group_by: "product" }],
  ["get_sales_summary", { from: FROM, to: TO, group_by: "customer" }],
  ["list_purchase_invoices", { from: FROM, to: TO }],
  ["search_parties", {}],
  ["get_outstanding_invoices", { kind: "sales" }],
  ["get_outstanding_invoices", { kind: "purchases" }],
  ["list_accounts", { only_with_balance: true }],
  ["get_account_ledger", { account: "Cash", from: FROM, to: TO, limit: 5 }],
  ["get_cash_and_bank_balances", {}],
  ["get_trial_balance", {}],
  ["get_profit_and_loss", { from: FROM, to: TO }],
  ["get_balance_sheet", {}],
  ["list_expenses", { from: FROM, to: TO }],
  ["search_products", { sort: "stock_low", limit: 5 }],
];

let s: Session;
beforeAll(async () => {
  s = await connectAs(USER_A);
});
afterAll(async () => {
  await s.close();
  await pool.end();
});

describe("smoke: every tool runs for the dev tenant", () => {
  it("lists 16 read-only tools", async () => {
    const { tools } = await s.client.listTools();
    expect(tools).toHaveLength(16);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.annotations?.destructiveHint, t.name).toBe(false);
      expect(t.description?.length, t.name).toBeGreaterThan(60);
    }
  });

  it.each(CALLS)("%s %j", async (name, args) => {
    const r = await s.call(name, args);
    if (process.env.SHOW) console.log(name, JSON.stringify(r.data ?? r.text).slice(0, 1500));
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toBeTypeOf("object");
  });
});
