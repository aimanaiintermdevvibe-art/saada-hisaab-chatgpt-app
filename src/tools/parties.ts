import { z } from "zod";
import { containsPattern, Params } from "../db/tenant.js";
import { localDate, localDateTime, todayLocalSql } from "../db/time.js";
import { currency, limit, round2 } from "./common.js";
import { defineTool } from "./framework.js";

/** Unpaid balance of a sales/purchase invoice: net amount minus payments allocated to it. */
const paidSql = (allocCol: "saleInvoiceId" | "purchaseInvoiceId", invAlias: string) =>
  `COALESCE((SELECT sum(a.amount) FROM "InvoicePaymentAllocation" a
              WHERE a."tenantId" = $1 AND a."${allocCol}" = ${invAlias}.id), 0)`;

const searchParties = defineTool({
  name: "search_parties",
  title: "Search customers and vendors",
  description:
    "Finds customers and/or vendors by name, NTN/CNIC or phone, with their total business, last invoice date and " +
    "outstanding (unpaid) amount. Use it for 'who are my top customers', 'find vendor X', or " +
    "'how much has customer X bought'.",
  input: {
    kind: z.enum(["customer", "vendor", "all"]).default("all"),
    query: z.string().trim().min(1).max(100).optional().describe("Name, NTN/CNIC or phone (partial match). Omit to list all."),
    limit: limit(20, 100),
  },
  async run(args, db) {
    const result: Record<string, unknown> = { currency: currency() };

    if (args.kind !== "vendor") {
      const p = new Params();
      const where = [`b."tenantId" = $1`, `NOT b."isDeleted"`];
      if (args.query) {
        const q = p.add(containsPattern(args.query));
        where.push(`(b."businessName" ILIKE ${q} OR b."ntnCnic" ILIKE ${q})`);
      }
      result.customers = await db.query(
        `SELECT b."businessName" AS name, b."ntnCnic", b."registrationType", b.city, b.province,
                s.invoices, s."totalSales", s."lastInvoiceDate",
                COALESCE((SELECT sum(i."netAmount" - ${paidSql("saleInvoiceId", "i")})
                            FROM "Invoice" i
                           WHERE i."tenantId" = $1 AND i."buyerId" = b.id AND NOT i."isDeleted"
                             AND i.status = 'COMPLETE' AND i."paymentStatus" = 'DUE'), 0) AS outstanding
           FROM "Buyer" b
           CROSS JOIN LATERAL (
             SELECT count(*) AS invoices, COALESCE(sum(i."netAmount"), 0) AS "totalSales",
                    max(${localDate('i."createdAt"')}) AS "lastInvoiceDate"
               FROM "Invoice" i
              WHERE i."tenantId" = $1 AND i."buyerId" = b.id AND NOT i."isDeleted" AND i.status = 'COMPLETE'
           ) s
          WHERE ${where.join(" AND ")}
          ORDER BY s."totalSales" DESC, b."businessName"
          LIMIT ${p.add(args.limit)}`,
        p.values,
      );
    }

    if (args.kind !== "customer") {
      const p = new Params();
      const where = [`v."tenantId" = $1`, `NOT v."isDeleted"`];
      if (args.query) {
        const q = p.add(containsPattern(args.query));
        where.push(`(v.name ILIKE ${q} OR v."ntnCnic" ILIKE ${q} OR v.phone ILIKE ${q})`);
      }
      result.vendors = await db.query(
        `SELECT v.name, v."ntnCnic", v.phone, v.business, v.city, v.province,
                s.invoices, s."totalPurchases", s."lastInvoiceDate",
                COALESCE((SELECT sum(pi."netAmount" - ${paidSql("purchaseInvoiceId", "pi")})
                            FROM "PurchaseInvoice" pi
                           WHERE pi."tenantId" = $1 AND pi."vendorId" = v.id AND NOT pi."isDeleted"
                             AND pi.status = 'COMPLETE' AND pi."paymentStatus" = 'DUE'), 0) AS outstanding
           FROM "Vendor" v
           CROSS JOIN LATERAL (
             SELECT count(*) AS invoices, COALESCE(sum(pi."netAmount"), 0) AS "totalPurchases",
                    max(${localDate('pi."createdAt"')}) AS "lastInvoiceDate"
               FROM "PurchaseInvoice" pi
              WHERE pi."tenantId" = $1 AND pi."vendorId" = v.id AND NOT pi."isDeleted" AND pi.status = 'COMPLETE'
           ) s
          WHERE ${where.join(" AND ")}
          ORDER BY s."totalPurchases" DESC, v.name
          LIMIT ${p.add(args.limit)}`,
        p.values,
      );
    }
    return result;
  },
});

const getOutstandingInvoices = defineTool({
  name: "get_outstanding_invoices",
  title: "Get outstanding invoices",
  description:
    "Lists unpaid invoices with the balance still due and how many days old each one is, plus totals per party. " +
    "kind='sales' = money customers owe the business (receivables); kind='purchases' = money the business owes " +
    "vendors (payables). Use it for 'who owes me money', 'what do I owe', or 'overdue invoices'.",
  input: {
    kind: z.enum(["sales", "purchases"]).default("sales"),
    party: z.string().trim().min(1).max(100).optional().describe("Customer or vendor name (partial match)."),
    limit: limit(50, 200),
  },
  async run(args, db) {
    const sales = args.kind === "sales";
    const t = sales
      ? { table: '"Invoice"', alias: "i", party: `COALESCE(w.name, b."businessName")`, alloc: "saleInvoiceId" as const,
          joins: `LEFT JOIN "Buyer" b ON b.id = i."buyerId" AND b."tenantId" = $1
                  LEFT JOIN "WalkInCustomer" w ON w.id = i."walkInCustomerId" AND w."tenantId" = $1` }
      : { table: '"PurchaseInvoice"', alias: "i", party: "v.name", alloc: "purchaseInvoiceId" as const,
          joins: `LEFT JOIN "Vendor" v ON v.id = i."vendorId" AND v."tenantId" = $1` };

    const p = new Params();
    const where = [`i."tenantId" = $1`, `NOT i."isDeleted"`, `i.status = 'COMPLETE'`, `i."paymentStatus" = 'DUE'`];
    if (args.party) where.push(`${t.party} ILIKE ${p.add(containsPattern(args.party))}`);

    const rows = await db.query<{
      invoiceNumber: string;
      date: string;
      party: string | null;
      netAmount: number;
      paid: number;
      balanceDue: number;
      ageDays: number;
    }>(
      `SELECT i."invoiceNumber", ${localDateTime('i."createdAt"')} AS date, ${t.party} AS party,
              i."netAmount", ${paidSql(t.alloc, "i")} AS paid,
              i."netAmount" - ${paidSql(t.alloc, "i")} AS "balanceDue",
              (${todayLocalSql} - ${localDate('i."createdAt"')}) AS "ageDays"
         FROM ${t.table} i ${t.joins}
        WHERE ${where.join(" AND ")}
        ORDER BY i."createdAt" ASC`,
      p.values,
    );

    const byParty = new Map<string, { party: string; invoices: number; balanceDue: number; oldestDays: number }>();
    for (const r of rows) {
      const key = r.party ?? "Unknown";
      const e = byParty.get(key) ?? { party: key, invoices: 0, balanceDue: 0, oldestDays: 0 };
      e.invoices += 1;
      e.balanceDue = round2(e.balanceDue + r.balanceDue);
      e.oldestDays = Math.max(e.oldestDays, r.ageDays);
      byParty.set(key, e);
    }

    return {
      kind: args.kind,
      currency: currency(),
      totalBalanceDue: round2(rows.reduce((s, r) => s + r.balanceDue, 0)),
      invoiceCount: rows.length,
      byParty: [...byParty.values()].sort((a, b) => b.balanceDue - a.balanceDue),
      invoices: rows.slice(0, args.limit),
      truncated: rows.length > args.limit,
      note: "Based on invoices marked DUE. Older invoices created before payment tracking (no payment status) are not included.",
    };
  },
});

export const partyTools = [searchParties, getOutstandingInvoices];
