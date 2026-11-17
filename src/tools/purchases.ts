import { z } from "zod";
import { containsPattern, Params } from "../db/tenant.js";
import { dateRangeConditions, localDateTime } from "../db/time.js";
import { checkRange, currency, fromDate, limit, offset, resolveInvoiceNumber, round2, toDate } from "./common.js";
import { defineTool, ToolError } from "./framework.js";

const FROM_PURCHASE = `
  FROM "PurchaseInvoice" pi
  LEFT JOIN "Vendor" v ON v.id = pi."vendorId" AND v."tenantId" = $1
  LEFT JOIN "Branch" br ON br.id = pi."branchId" AND br."tenantId" = $1`;

const SORTS = { newest: 'pi."createdAt" DESC', oldest: 'pi."createdAt" ASC', largest: 'pi."netAmount" DESC', smallest: 'pi."netAmount" ASC' } as const;

const listPurchaseInvoices = defineTool({
  name: "list_purchase_invoices",
  title: "List purchase invoices",
  description:
    "Finds purchase invoices (bills from vendors/suppliers) with filters (dates, vendor, payment status, " +
    "amount) and returns them with totals for everything that matched. Use it for 'what did I buy last month', " +
    "'bills from vendor X', or 'unpaid purchase bills'. For one bill's line items use get_purchase_invoice.",
  input: {
    from: fromDate("Optional."),
    to: toDate("Optional."),
    vendor: z.string().trim().min(1).max(100).optional().describe("Vendor name (partial match)."),
    status: z.enum(["COMPLETE", "DRAFT", "CANCELLED", "FAILED", "ALL"]).default("COMPLETE"),
    payment_status: z.enum(["DUE", "PAID", "OVERPAID"]).optional(),
    invoice_number: z.string().trim().min(1).max(60).optional().describe("Purchase invoice number (partial match)."),
    min_amount: z.number().nonnegative().optional(),
    max_amount: z.number().nonnegative().optional(),
    sort: z.enum(["newest", "oldest", "largest", "smallest"]).default("newest"),
    limit: limit(20, 100),
    offset,
  },
  async run(args, db) {
    checkRange(args.from, args.to);
    const p = new Params();
    const where = [`pi."tenantId" = $1`, `NOT pi."isDeleted"`];
    if (args.status !== "ALL") where.push(`pi.status = ${p.add(args.status)}::"InvoiceStatus"`);
    where.push(...dateRangeConditions('pi."createdAt"', (v) => p.add(v), args.from, args.to));
    if (args.vendor) where.push(`v.name ILIKE ${p.add(containsPattern(args.vendor))}`);
    if (args.payment_status) where.push(`pi."paymentStatus" = ${p.add(args.payment_status)}::"PaymentStatus"`);
    if (args.invoice_number) where.push(`pi."invoiceNumber" ILIKE ${p.add(containsPattern(args.invoice_number))}`);
    if (args.min_amount !== undefined) where.push(`pi."netAmount" >= ${p.add(args.min_amount)}`);
    if (args.max_amount !== undefined) where.push(`pi."netAmount" <= ${p.add(args.max_amount)}`);
    const whereSql = where.join(" AND ");

    const [totals] = await db.query<{ count: number; gross: number; discount: number; tax: number; net: number }>(
      `SELECT count(*) AS count, COALESCE(sum(pi."grossAmount"), 0) AS gross, COALESCE(sum(pi.discount), 0) AS discount,
              COALESCE(sum(pi.tax), 0) AS tax, COALESCE(sum(pi."netAmount"), 0) AS net
       ${FROM_PURCHASE} WHERE ${whereSql}`,
      p.values,
    );
    const limitP = p.add(args.limit);
    const offsetP = p.add(args.offset);
    const invoices = await db.query(
      `SELECT pi."invoiceNumber", ${localDateTime('pi."createdAt"')} AS date, v.name AS vendor,
              pi.status::text AS status, pi."paymentStatus"::text AS "paymentStatus", pi."paymentMode",
              pi."grossAmount", COALESCE(pi.discount, 0) AS discount, pi.tax, pi."netAmount", br.name AS branch
       ${FROM_PURCHASE} WHERE ${whereSql}
       ORDER BY ${SORTS[args.sort]}, pi.id
       LIMIT ${limitP} OFFSET ${offsetP}`,
      p.values,
    );
    return {
      currency: currency(),
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

const getPurchaseInvoice = defineTool({
  name: "get_purchase_invoice",
  title: "Get purchase invoice",
  description:
    "Returns one purchase invoice (vendor bill) in full: vendor, date, amounts, line items (product, quantity, " +
    "unit, price, discount, tax, total), payments made against it, and purchase returns. " +
    "Use it when the user names a specific purchase invoice number.",
  input: {
    invoice_number: z.string().trim().min(1).max(60).describe("The purchase invoice number, or a unique part of it."),
  },
  async run(args, db) {
    const invoiceNumber = await resolveInvoiceNumber(db, "purchase", args.invoice_number);
    const [inv] = await db.query<Record<string, unknown> & { id: string }>(
      `SELECT pi.id, pi."invoiceNumber", ${localDateTime('pi."createdAt"')} AS date, v.name AS vendor, v.phone AS "vendorPhone",
              v."ntnCnic" AS "vendorNtnCnic", pi.status::text AS status, pi."paymentStatus"::text AS "paymentStatus",
              pi."paymentMode", pi."grossAmount", pi.discount, pi.tax, pi."landedCost", pi."netAmount", pi.remarks,
              br.name AS branch, u."fullName" AS "createdBy"
       ${FROM_PURCHASE}
       LEFT JOIN "User" u ON u.id = pi."userId" AND u."tenantId" = $1
       WHERE pi."tenantId" = $1 AND pi."invoiceNumber" = $2 AND NOT pi."isDeleted"
       ORDER BY pi."createdAt" DESC LIMIT 1`,
      [invoiceNumber],
    );
    if (!inv) throw new ToolError(`No purchase invoice numbered ${invoiceNumber} was found.`);
    const { id, ...invoice } = inv;

    const items = await db.query(
      `SELECT p.name AS product, it.quantity, u.name AS unit, it."productPrice" AS "unitPrice",
              it."totalDiscount" AS discount, it."totalTax" AS tax, it."totalValues" AS total
         FROM "PurchaseInvoiceItems" it
         JOIN "PurchaseInvoice" pi ON pi.id = it."invoiceId" AND pi."tenantId" = $1
         LEFT JOIN "Product" p ON p.id = it."productId" AND p."tenantId" = $1
         LEFT JOIN "InternalUom" u ON u.id = it."internalUomId" AND u."tenantId" = $1
        WHERE it."invoiceId" = $2
        ORDER BY it.id`,
      [id],
    );
    const payments = await db.query(
      `SELECT ${localDateTime('"createdAt"')} AS date, amount, "sourceType"::text AS source
         FROM "InvoicePaymentAllocation" WHERE "tenantId" = $1 AND "purchaseInvoiceId" = $2 ORDER BY "createdAt"`,
      [id],
    );
    const returns = await db.query(
      `SELECT "invoiceNumber" AS "returnNumber", ${localDateTime('"createdAt"')} AS date, "netAmount"
         FROM "PurchaseReturn" WHERE "tenantId" = $1 AND "invoiceRefId" = $2 AND NOT "isDeleted" ORDER BY "createdAt"`,
      [id],
    );
    return { currency: currency(), invoice, items, payments, returns };
  },
});

export const purchaseTools = [listPurchaseInvoices, getPurchaseInvoice];
