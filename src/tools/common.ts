import { z } from "zod";
import { config } from "../config.js";
import { containsPattern, type TenantDb } from "../db/tenant.js";
import { ToolError } from "./framework.js";

// ---------- Invoice lookup ----------

const INVOICE_TABLES = {
  sales: { table: '"Invoice"', label: "sales invoice", hint: "list_sales_invoices" },
  purchase: { table: '"PurchaseInvoice"', label: "purchase invoice", hint: "list_purchase_invoices" },
} as const;

/**
 * Turns what the user typed into one invoice number: an exact match, or the only invoice whose
 * number contains the text. Several partial matches raise a ToolError listing them so ChatGPT can ask.
 */
export async function resolveInvoiceNumber(db: TenantDb, kind: keyof typeof INVOICE_TABLES, text: string): Promise<string> {
  const t = INVOICE_TABLES[kind];
  const rows = await db.query<{ invoiceNumber: string }>(
    `SELECT "invoiceNumber" FROM ${t.table}
      WHERE "tenantId" = $1 AND NOT "isDeleted" AND "invoiceNumber" ILIKE $2
      ORDER BY ("invoiceNumber" = $3) DESC, "createdAt" DESC
      LIMIT 6`,
    [containsPattern(text), text],
  );
  const first = rows[0];
  if (!first) {
    throw new ToolError(`No ${t.label} numbered ${text} was found. Use ${t.hint} to search by party, date or amount.`);
  }
  if (first.invoiceNumber === text || rows.length === 1) return first.invoiceNumber;
  const shown = rows.slice(0, 5).map((r) => r.invoiceNumber).join(", ");
  throw new ToolError(
    `Several ${t.label}s contain "${text}": ${shown}${rows.length > 5 ? ", ..." : ""}. Ask which one, or use the full number.`,
  );
}

// ---------- Input schemas ----------

function isRealDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
  .refine(isRealDate, "Not a real calendar date");

export const fromDate = (defaultNote: string) =>
  isoDate.optional().describe(`Start date, inclusive (YYYY-MM-DD, business local time). ${defaultNote}`);

export const toDate = (defaultNote: string) =>
  isoDate.optional().describe(`End date, inclusive (YYYY-MM-DD, business local time). ${defaultNote}`);

export const limit = (defaultValue: number, max: number) =>
  z.number().int().min(1).max(max).default(defaultValue).describe(`Maximum rows to return (default ${defaultValue}, max ${max}).`);

export const offset = z.number().int().min(0).default(0).describe("Rows to skip, for paging through long lists.");

export function checkRange(from?: string, to?: string): void {
  if (from && to && from > to) throw new ToolError(`The start date ${from} is after the end date ${to}.`);
}

// ---------- Numbers ----------

/** Rounds to 2 decimals and normalises -0 to 0. */
export function round2(n: number): number {
  return Number(n.toFixed(2)) || 0;
}

export const currency = () => config.CURRENCY;

// ---------- Labels ----------

/** JournalEntry.refType codes as shown in Saada Hisaab. */
export const REF_TYPE_LABELS: Record<string, string> = {
  S: "Sale",
  P: "Purchase",
  SR: "Sale return",
  PR: "Purchase return",
  JV: "Journal voucher",
  CPV: "Cash payment voucher",
  CRV: "Cash receipt voucher",
  BPV: "Bank payment voucher",
  BRV: "Bank receipt voucher",
  OS: "Opening stock",
  ADJ: "Stock adjustment",
  EXP: "Expense",
  PRL: "Payroll",
  OB: "Opening balance",
  SC: "Sale cancellation",
  SR_SETTLEMENT_PAY: "Sale return settlement (paid)",
  SR_SETTLEMENT_RECEIVE: "Sale return settlement (received)",
  PR_SETTLEMENT_PAY: "Purchase return settlement (paid)",
  PR_SETTLEMENT_RECEIVE: "Purchase return settlement (received)",
};

export const refTypeLabel = (code: string) => REF_TYPE_LABELS[code] ?? code;
