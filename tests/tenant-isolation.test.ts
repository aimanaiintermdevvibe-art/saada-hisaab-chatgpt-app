import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db/pool.js";
import { assertTenantScoped, withTenant } from "../src/db/tenant.js";
import { connectAs, USER_A, USER_B, type Session } from "./helpers.js";

let A: Session;
let B: Session;

/** Ground truth straight from the database (the read-only role can see all tenants; tools must not). */
async function truth(sql: string, tenantId: string): Promise<Set<string>> {
  const { rows } = await pool.query<{ v: string }>(sql, [tenantId]);
  return new Set(rows.map((r) => r.v));
}

/** Pages through list_sales_invoices / list_purchase_invoices and collects every invoice number. */
async function allInvoiceNumbers(s: Session, tool: string): Promise<Set<string>> {
  const seen = new Set<string>();
  for (let offset = 0; ; offset += 100) {
    const r = await s.call(tool, { status: "ALL", limit: 100, offset });
    expect(r.isError, r.text).toBe(false);
    for (const inv of r.data.invoices) seen.add(inv.invoiceNumber);
    if (!r.data.hasMore) return seen;
  }
}

beforeAll(async () => {
  A = await connectAs(USER_A);
  B = await connectAs(USER_B);
  expect(A.caller.tenantId).not.toBe(B.caller.tenantId);
});
afterAll(async () => {
  await A.close();
  await B.close();
  await pool.end();
});

describe("tenant guard", () => {
  it("rejects SQL that does not filter on $1", () => {
    expect(() => assertTenantScoped(`SELECT * FROM "Invoice"`)).toThrow(/Tenant guard/);
    expect(() => assertTenantScoped(`SELECT * FROM "Invoice" WHERE id = $10`)).toThrow(/Tenant guard/);
    expect(() => assertTenantScoped(`SELECT * FROM "Invoice" WHERE "tenantId" = $1`)).not.toThrow();
  });

  it("refuses to run an unscoped query", async () => {
    await expect(withTenant(A.caller.tenantId, (db) => db.query(`SELECT count(*) FROM "Invoice"`))).rejects.toThrow(/Tenant guard/);
  });

  it("refuses an empty tenant id", async () => {
    await expect(withTenant("", (db) => db.query(`SELECT 1 WHERE $1 IS NOT NULL`))).rejects.toThrow(/missing tenant/);
  });

  it("runs inside a read-only transaction", async () => {
    await expect(
      withTenant(A.caller.tenantId, (db) => db.query(`UPDATE "Branch" SET name = name WHERE "tenantId" = $1`)),
    ).rejects.toThrow(/read-only/);
  });
});

describe("each user only sees their own tenant", () => {
  it("business profile is the caller's business", async () => {
    expect((await A.call("get_business_profile")).data.business.businessName).toBe(A.caller.businessName);
    expect((await B.call("get_business_profile")).data.business.businessName).toBe(B.caller.businessName);
  });

  it.each([
    ["list_sales_invoices", `SELECT "invoiceNumber" AS v FROM "Invoice" WHERE "tenantId" = $1 AND NOT "isDeleted"`],
    ["list_purchase_invoices", `SELECT "invoiceNumber" AS v FROM "PurchaseInvoice" WHERE "tenantId" = $1 AND NOT "isDeleted"`],
  ])("%s returns exactly the tenant's invoices", async (tool, sql) => {
    for (const s of [A, B]) {
      const got = await allInvoiceNumbers(s, tool);
      expect(got).toEqual(await truth(sql, s.caller.tenantId));
    }
  });

  it("cannot open another tenant's sales or purchase invoice by number", async () => {
    const bSale = [...(await truth(`SELECT "invoiceNumber" AS v FROM "Invoice" WHERE "tenantId" = $1`, B.caller.tenantId))][0]!;
    const bPurchase = [...(await truth(`SELECT "invoiceNumber" AS v FROM "PurchaseInvoice" WHERE "tenantId" = $1`, B.caller.tenantId))][0]!;

    expect((await B.call("get_sales_invoice", { invoice_number: bSale })).isError).toBe(false);
    const crossSale = await A.call("get_sales_invoice", { invoice_number: bSale });
    expect(crossSale.isError).toBe(true);
    expect(crossSale.text).toMatch(/not found|No sales invoice/i);

    expect((await B.call("get_purchase_invoice", { invoice_number: bPurchase })).isError).toBe(false);
    expect((await A.call("get_purchase_invoice", { invoice_number: bPurchase })).isError).toBe(true);
  });

  it("customers and vendors come only from the caller's tenant", async () => {
    for (const s of [A, B]) {
      const r = await s.call("search_parties", { limit: 100 });
      const buyers = await truth(`SELECT "businessName" AS v FROM "Buyer" WHERE "tenantId" = $1 AND NOT "isDeleted"`, s.caller.tenantId);
      const vendors = await truth(`SELECT name AS v FROM "Vendor" WHERE "tenantId" = $1 AND NOT "isDeleted"`, s.caller.tenantId);
      expect(new Set(r.data.customers.map((c: { name: string }) => c.name))).toEqual(buyers);
      expect(new Set(r.data.vendors.map((v: { name: string }) => v.name))).toEqual(vendors);
    }
  });

  it("products come only from the caller's tenant", async () => {
    for (const s of [A, B]) {
      const r = await s.call("search_products", { include_disabled: true, limit: 100 });
      const names = await truth(`SELECT name AS v FROM "Product" WHERE "tenantId" = $1 AND NOT "isDeleted"`, s.caller.tenantId);
      expect(r.data.totalMatching).toBeLessThanOrEqual(100); // both test tenants are small
      expect(new Set(r.data.products.map((p: { name: string }) => p.name))).toEqual(names);
    }
  });

  it("expenses come only from the caller's tenant", async () => {
    const range = { from: "2000-01-01", to: "2100-12-31" };
    const a = await A.call("list_expenses", range);
    const b = await B.call("list_expenses", range);
    expect(new Set(a.data.expenses.map((e: { expenseNo: string }) => e.expenseNo))).toEqual(
      await truth(`SELECT "expenseNo" AS v FROM "Expense" WHERE "tenantId" = $1`, A.caller.tenantId),
    );
    expect(new Set(b.data.expenses.map((e: { expenseNo: string }) => e.expenseNo))).toEqual(
      await truth(`SELECT "expenseNo" AS v FROM "Expense" WHERE "tenantId" = $1`, B.caller.tenantId),
    );
    expect(b.data.count).toBeGreaterThan(0);
  });

  it("the same account code resolves to each tenant's own account", async () => {
    const range = { account: "10101", from: "2000-01-01", to: "2100-12-31", limit: 1 };
    for (const s of [A, B]) {
      const r = await s.call("get_account_ledger", range);
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "JournalLine" jl JOIN "Account" a ON a.id = jl."accountId"
          WHERE a."tenantId" = $1 AND a.code = '10101'`,
        [s.caller.tenantId],
      );
      expect(r.data.lineCount).toBe(rows[0]!.n);
    }
  });
});
