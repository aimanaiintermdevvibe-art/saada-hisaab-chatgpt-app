import { z } from "zod";
import { containsPattern, Params } from "../db/tenant.js";
import { dateRangeConditions, localDate, localDateTime, localTs, todayLocal, yearStartLocal } from "../db/time.js";
import { checkRange, currency, fromDate, limit, offset, resolveInvoiceNumber, round2, toDate } from "./common.js";
import { defineTool, ToolError } from "./framework.js";

const INVOICE_STATUSES = ["COMPLETE", "DRAFT", "CANCELLED", "FAILED", "ALL"] as const;
const PAYMENT_STATUSES = ["DUE", "PAID", "OVERPAID"] as const;
const FBR_STATUSES = ["VALID", "INVALID", "FAILED", "CANCELLED", "NOT_SUBMITTED"] as const;
const SORTS = { newest: 'i."createdAt" DESC', oldest: 'i."createdAt" ASC', largest: 'i."netAmount" DESC', smallest: 'i."netAmount" ASC' } as const;

const CUSTOMER_NAME = `COALESCE(w.name, b."businessName")`;
const FROM_INVOICE = `
  FROM "Invoice" i
  LEFT JOIN "Buyer" b ON b.id = i."buyerId" AND b."tenantId" = $1
  LEFT JOIN "WalkInCustomer" w ON w.id = i."walkInCustomerId" AND w."tenantId" = $1
  LEFT JOIN "Branch" br ON br.id = i."branchId" AND br."tenantId" = $1`;

const SALES_BASIS = "Built from sales invoices with status COMPLETE (drafts, failed, cancelled and deleted invoices excluded).";

const listSalesInvoices = defineTool({
  name: "list_sales_invoices",
  title: "List sales invoices",
  description:
    "Finds sales invoices with filters (dates, customer, payment status, FBR status, payment mode, amount) " +
    "and returns them newest first with totals for everything that matched. Use it for 'show my invoices from " +
    "last week', 'unpaid invoices of customer X', or 'invoices that failed FBR submission'. " +
    "For one invoice's line items use get_sales_invoice.",
  input: {
    from: fromDate("Optional."),
    to: toDate("Optional."),
    customer: z.string().trim().min(1).max(100).optional().describe("Customer name (partial match)."),
    status: z.enum(INVOICE_STATUSES).default("COMPLETE").describe("Invoice status. Defaults to COMPLETE (finalised sales)."),
    payment_status: z.enum(PAYMENT_STATUSES).optional().describe("DUE = not fully paid, PAID, or OVERPAID."),
    fbr_status: z.enum(FBR_STATUSES).optional().describe("FBR digital-invoicing status. NOT_SUBMITTED = never sent to FBR."),
    payment_mode: z.string().trim().max(20).optional().describe("Payment mode, e.g. CASH, CREDIT, ONLINE."),
    invoice_number: z.string().trim().min(1).max(60).optional().describe("Invoice number (partial match)."),
    min_amount: z.number().nonnegative().optional().describe("Minimum net amount."),
    max_amount: z.number().nonnegative().optional().describe("Maximum net amount."),
    sort: z.enum(["newest", "oldest", "largest", "smallest"]).default("newest"),
    limit: limit(20, 100),
    offset,
  },
  async run(args, db) {
    checkRange(args.from, args.to);
    const p = new Params();
    const where = [`i."tenantId" = $1`, `NOT i."isDeleted"`];
    if (args.status !== "ALL") where.push(`i.status = ${p.add(args.status)}::"InvoiceStatus"`);
    where.push(...dateRangeConditions('i."createdAt"', (v) => p.add(v), args.from, args.to));
    if (args.customer) where.push(`${CUSTOMER_NAME} ILIKE ${p.add(containsPattern(args.customer))}`);
    if (args.payment_status) where.push(`i."paymentStatus" = ${p.add(args.payment_status)}::"PaymentStatus"`);
    if (args.fbr_status === "NOT_SUBMITTED") where.push(`i."fbrStatus" IS NULL`);
    else if (args.fbr_status) where.push(`i."fbrStatus" = ${p.add(args.fbr_status)}::"Status"`);
    if (args.payment_mode) where.push(`upper(i."paymentMode") = upper(${p.add(args.payment_mode)})`);
    if (args.invoice_number) where.push(`i."invoiceNumber" ILIKE ${p.add(containsPattern(args.invoice_number))}`);
    if (args.min_amount !== undefined) where.push(`i."netAmount" >= ${p.add(args.min_amount)}`);
    if (args.max_amount !== undefined) where.push(`i."netAmount" <= ${p.add(args.max_amount)}`);
    const whereSql = where.join(" AND ");

    const [totals] = await db.query<{ count: number; gross: number; discount: number; tax: number; net: number }>(
      `SELECT count(*) AS count, COALESCE(sum(i."grossAmount"), 0) AS gross,
              COALESCE(sum(COALESCE(i.discount, 0) + COALESCE(i."extraDiscount", 0)), 0) AS discount,
              COALESCE(sum(i.tax + COALESCE(i."extraTax", 0)), 0) AS tax, COALESCE(sum(i."netAmount"), 0) AS net
       ${FROM_INVOICE} WHERE ${whereSql}`,
      p.values,
    );

    const limitP = p.add(args.limit);
    const offsetP = p.add(args.offset);
    const invoices = await db.query(
      `SELECT i."invoiceNumber", ${localDateTime('i."createdAt"')} AS date, ${CUSTOMER_NAME} AS customer,
              i.status::text AS status, i."paymentStatus"::text AS "paymentStatus", i."paymentMode",
              i."fbrStatus"::text AS "fbrStatus", i."grossAmount",
              COALESCE(i.discount, 0) + COALESCE(i."extraDiscount", 0) AS discount,
              i.tax + COALESCE(i."extraTax", 0) AS tax, i."netAmount", br.name AS branch
       ${FROM_INVOICE} WHERE ${whereSql}
       ORDER BY ${SORTS[args.sort]}, i.id
       LIMIT ${limitP} OFFSET ${offsetP}`,
      p.values,
    );

    return {
      currency: currency(),
      filters: { from: args.from ?? null, to: args.to ?? null, status: args.status },
      totals: totals && {
        invoices: totals.count,
        grossAmount: round2(totals.gross),
        discount: round2(totals.discount),
        tax: round2(totals.tax),
        netAmount: round2(totals.net),
      },
      invoices,
      returned: invoices.length,
      offset: args.offset,
      hasMore: args.offset + invoices.length < (totals?.count ?? 0),
    };
  },
});

const getSalesInvoice = defineTool({
  name: "get_sales_invoice",
  title: "Get sales invoice",
  description:
    "Returns one sales invoice in full: customer, date, amounts, line items (product, quantity, unit, price, " +
    "sales tax, total), payments received against it, returns, and FBR submission status. " +
    "Use it when the user names a specific invoice number.",
  input: {
    invoice_number: z.string().trim().min(1).max(60).describe("The invoice number, or a unique part of it."),
  },
  async run(args, db) {
    const invoiceNumber = await resolveInvoiceNumber(db, "sales", args.invoice_number);
    const [inv] = await db.query<Record<string, unknown> & { id: string }>(
      `SELECT i.id, i."invoiceNumber", ${localDateTime('i."createdAt"')} AS date, ${CUSTOMER_NAME} AS customer,
              b."ntnCnic" AS "customerNtnCnic", b.address AS "customerAddress", (i."walkInCustomerId" IS NOT NULL) AS "walkIn",
              i."invoiceType", i.status::text AS status, i."paymentStatus"::text AS "paymentStatus", i."paymentMode",
              i."grossAmount", i.discount, i."extraDiscount", i.tax, i."extraTax", i."netAmount",
              i."fbrStatus"::text AS "fbrStatus", i.usin AS "fbrInvoiceNumber", i.remarks,
              br.name AS branch, u."fullName" AS "createdBy", ${localDateTime('i."completedOn"')} AS "completedOn",
              EXISTS (SELECT 1 FROM "JournalEntry" je WHERE je."tenantId" = $1 AND je."refType" = 'S' AND je."refId" = i.id) AS "postedToAccounts"
       ${FROM_INVOICE}
       LEFT JOIN "User" u ON u.id = i."userId" AND u."tenantId" = $1
       WHERE i."tenantId" = $1 AND i."invoiceNumber" = $2 AND NOT i."isDeleted"
       ORDER BY i."createdAt" DESC LIMIT 1`,
      [invoiceNumber],
    );
    if (!inv) throw new ToolError(`No sales invoice numbered ${invoiceNumber} was found.`);
    const { id, ...invoice } = inv;

    const items = await db.query(
      `SELECT p.name AS product, p."hsCode", ii.quantity, u.name AS unit, ii."productPrice" AS "unitPrice",
              ii."valueSalesExcludingST" AS "valueExcludingTax", ii."salesTaxApplicable" AS "salesTax",
              ii."furtherTax", ii."extraTax", COALESCE(ii.discount, 0) + COALESCE(ii."extraDiscount", 0) AS discount,
              ii."totalValues" AS total
         FROM "InvoiceItems" ii
         JOIN "Invoice" i ON i.id = ii."invoiceId" AND i."tenantId" = $1
         LEFT JOIN "Product" p ON p.id = ii."productId" AND p."tenantId" = $1
         LEFT JOIN "InternalUom" u ON u.id = ii."internalUomId" AND u."tenantId" = $1
        WHERE ii."invoiceId" = $2
        ORDER BY ii.id`,
      [id],
    );
    const payments = await db.query(
      `SELECT ${localDateTime('"createdAt"')} AS date, amount, "sourceType"::text AS source
         FROM "InvoicePaymentAllocation"
        WHERE "tenantId" = $1 AND "saleInvoiceId" = $2
        ORDER BY "createdAt"`,
      [id],
    );
    const returns = await db.query(
      `SELECT "invoiceNumber" AS "returnNumber", ${localDateTime('"createdAt"')} AS date, "netAmount"
         FROM "SaleReturn" WHERE "tenantId" = $1 AND "invoiceRefId" = $2 AND NOT "isDeleted"
        ORDER BY "createdAt"`,
      [id],
    );
    return { currency: currency(), invoice, items, payments, returns };
  },
});

const GROUPINGS = ["day", "week", "month", "customer", "product", "payment_mode", "branch"] as const;

const getSalesSummary = defineTool({
  name: "get_sales_summary",
  title: "Get sales summary",
  description:
    "Summarises completed sales for a period, grouped by day, week, month, customer, product, payment mode " +
    "or branch, with period totals and sale returns. Use it for 'how were sales this month', 'top customers', " +
    "'best-selling products', or 'daily sales trend'.",
  input: {
    from: fromDate("Defaults to the start of the current year."),
    to: toDate("Defaults to today."),
    group_by: z.enum(GROUPINGS).default("month"),
    limit: limit(31, 100),
  },
  async run(args, db) {
    const from = args.from ?? yearStartLocal();
    const to = args.to ?? todayLocal();
    checkRange(from, to);

    const p = new Params();
    const where = [`i."tenantId" = $1`, `NOT i."isDeleted"`, `i.status = 'COMPLETE'`];
    where.push(...dateRangeConditions('i."createdAt"', (v) => p.add(v), from, to));
    const whereSql = where.join(" AND ");
    const limitP = p.add(args.limit);

    let rows: Record<string, unknown>[];
    if (args.group_by === "product") {
      rows = await db.query(
        `SELECT p.name AS product, u.name AS unit, count(DISTINCT i.id) AS invoices, sum(ii.quantity) AS quantity,
                sum(ii."valueSalesExcludingST") AS "salesExcludingTax", sum(ii."salesTaxApplicable") AS "salesTax",
                sum(ii."totalValues") AS total
           FROM "InvoiceItems" ii
           JOIN "Invoice" i ON i.id = ii."invoiceId"
           LEFT JOIN "Product" p ON p.id = ii."productId" AND p."tenantId" = $1
           LEFT JOIN "InternalUom" u ON u.id = ii."internalUomId" AND u."tenantId" = $1
          WHERE ${whereSql}
          GROUP BY p.id, p.name, u.name
          ORDER BY total DESC NULLS LAST
          LIMIT ${limitP}`,
        p.values,
      );
    } else {
      const key = {
        day: `to_char(${localDate('i."createdAt"')}, 'YYYY-MM-DD')`,
        week: `to_char(date_trunc('week', ${localTs('i."createdAt"')}), 'YYYY-MM-DD')`,
        month: `to_char(${localTs('i."createdAt"')}, 'YYYY-MM')`,
        customer: CUSTOMER_NAME,
        payment_mode: `COALESCE(i."paymentMode", 'Not recorded')`,
        branch: `COALESCE(br.name, 'No branch')`,
      }[args.group_by];
      const isTime = ["day", "week", "month"].includes(args.group_by);
      rows = await db.query(
        `SELECT ${key} AS "${args.group_by === "week" ? "weekStarting" : args.group_by}",
                count(*) AS invoices, sum(i."grossAmount") AS "grossAmount",
                sum(COALESCE(i.discount, 0) + COALESCE(i."extraDiscount", 0)) AS discount,
                sum(i.tax + COALESCE(i."extraTax", 0)) AS tax, sum(i."netAmount") AS "netAmount"
         ${FROM_INVOICE}
          WHERE ${whereSql}
          GROUP BY 1
          ORDER BY ${isTime ? "1 ASC" : '"netAmount" DESC'}
          LIMIT ${limitP}`,
        p.values,
      );
    }

    const tp = new Params();
    const tWhere = [`i."tenantId" = $1`, `NOT i."isDeleted"`, `i.status = 'COMPLETE'`, ...dateRangeConditions('i."createdAt"', (v) => tp.add(v), from, to)];
    const [totals] = await db.query<{ invoices: number; gross: number; discount: number; tax: number; net: number; customers: number }>(
      `SELECT count(*) AS invoices, COALESCE(sum(i."grossAmount"), 0) AS gross,
              COALESCE(sum(COALESCE(i.discount, 0) + COALESCE(i."extraDiscount", 0)), 0) AS discount,
              COALESCE(sum(i.tax + COALESCE(i."extraTax", 0)), 0) AS tax, COALESCE(sum(i."netAmount"), 0) AS net,
              count(DISTINCT i."buyerId") AS customers
         FROM "Invoice" i WHERE ${tWhere.join(" AND ")}`,
      tp.values,
    );

    const rp = new Params();
    const rWhere = [`r."tenantId" = $1`, `NOT r."isDeleted"`, ...dateRangeConditions('r."createdAt"', (v) => rp.add(v), from, to)];
    const [returns] = await db.query<{ count: number; amount: number }>(
      `SELECT count(*) AS count, COALESCE(sum(r."netAmount"), 0) AS amount FROM "SaleReturn" r WHERE ${rWhere.join(" AND ")}`,
      rp.values,
    );

    const net = round2(totals?.net ?? 0);
    const returnsAmount = round2(returns?.amount ?? 0);
    return {
      period: { from, to },
      currency: currency(),
      groupBy: args.group_by,
      totals: {
        invoices: totals?.invoices ?? 0,
        customers: totals?.customers ?? 0,
        grossAmount: round2(totals?.gross ?? 0),
        discount: round2(totals?.discount ?? 0),
        tax: round2(totals?.tax ?? 0),
        netAmount: net,
        saleReturns: returns?.count ?? 0,
        saleReturnsAmount: returnsAmount,
        netAfterReturns: round2(net - returnsAmount),
      },
      rows,
      basis: SALES_BASIS,
    };
  },
});

export const salesTools = [listSalesInvoices, getSalesInvoice, getSalesSummary];
