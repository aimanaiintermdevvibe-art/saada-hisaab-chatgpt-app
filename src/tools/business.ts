import { config } from "../config.js";
import { localDate, todayLocal } from "../db/time.js";
import { currency } from "./common.js";
import { defineTool, ToolError } from "./framework.js";

const getBusinessProfile = defineTool({
  name: "get_business_profile",
  title: "Get business profile",
  description:
    "Returns the signed-in user's business: name, NTN, sales tax number, address, branches, the user's name and role, " +
    "currency, time zone, today's date, record counts, and the date range that has sales and accounting data. " +
    "Call it first when you need context, e.g. to pick a sensible date range or to greet the user by business name.",
  input: {},
  async run(_args, db, caller) {
    const [business] = await db.query(
      `SELECT t."businessName", t.address, t.province, t.phone, t.cell, t.ntn, t."ntnCnic", t."salesTaxNo",
              ind.name AS industry, t."isMultiBranch", t."isTrackExpiry" AS "tracksExpiry", t."isHrmEnabled" AS "hrmEnabled"
         FROM "Tenant" t
         LEFT JOIN "Industry" ind ON ind.id = t."industryId"
        WHERE t.id = $1`,
    );
    if (!business) throw new ToolError("Business not found.");

    const branches = await db.query(
      `SELECT name, city, province, address, "isWarehouse" FROM "Branch" WHERE "tenantId" = $1 ORDER BY name`,
    );
    const [stats] = await db.query(
      `SELECT
         (SELECT count(*) FROM "Invoice" WHERE "tenantId" = $1 AND NOT "isDeleted" AND status = 'COMPLETE') AS "salesInvoices",
         (SELECT count(*) FROM "PurchaseInvoice" WHERE "tenantId" = $1 AND NOT "isDeleted" AND status = 'COMPLETE') AS "purchaseInvoices",
         (SELECT count(*) FROM "Buyer" WHERE "tenantId" = $1 AND NOT "isDeleted") AS customers,
         (SELECT count(*) FROM "Vendor" WHERE "tenantId" = $1 AND NOT "isDeleted") AS vendors,
         (SELECT count(*) FROM "Product" WHERE "tenantId" = $1 AND NOT "isDeleted") AS products,
         (SELECT min(${localDate('"createdAt"')}) FROM "Invoice" WHERE "tenantId" = $1 AND NOT "isDeleted") AS "firstSaleDate",
         (SELECT max(${localDate('"createdAt"')}) FROM "Invoice" WHERE "tenantId" = $1 AND NOT "isDeleted") AS "lastSaleDate",
         (SELECT min(${localDate('"postedAt"')}) FROM "JournalEntry" WHERE "tenantId" = $1) AS "firstJournalDate",
         (SELECT max(${localDate('"postedAt"')}) FROM "JournalEntry" WHERE "tenantId" = $1) AS "lastJournalDate"`,
    );

    return {
      business,
      branches,
      signedInUser: { name: caller.fullName, role: caller.role },
      currency: currency(),
      timeZone: config.BUSINESS_TIMEZONE,
      today: todayLocal(),
      counts: stats && {
        salesInvoices: stats.salesInvoices,
        purchaseInvoices: stats.purchaseInvoices,
        customers: stats.customers,
        vendors: stats.vendors,
        products: stats.products,
      },
      dataCoverage: stats && {
        sales: { from: stats.firstSaleDate, to: stats.lastSaleDate },
        accounting: { from: stats.firstJournalDate, to: stats.lastJournalDate },
      },
    };
  },
});

export const businessTools = [getBusinessProfile];
