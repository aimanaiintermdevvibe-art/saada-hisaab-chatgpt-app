import { z } from "zod";
import { containsPattern, Params } from "../db/tenant.js";
import { currency, limit, offset } from "./common.js";
import { defineTool } from "./framework.js";

const SORTS = {
  name: "p.name ASC",
  stock_low: '"stockInDefaultUnit" ASC NULLS LAST, p.name',
  stock_high: '"stockInDefaultUnit" DESC NULLS LAST, p.name',
  price_high: "p.price DESC, p.name",
} as const;

const searchProducts = defineTool({
  name: "search_products",
  title: "Search products and stock",
  description:
    "Finds products by name, barcode, HS code or category and returns price, purchase price, tax rate and current " +
    "stock on hand. Use it for 'how many X do I have', 'what's the price of Y', 'low stock items' " +
    "(set max_stock and sort=stock_low), or 'list products in category Z'.",
  input: {
    query: z.string().trim().min(1).max(100).optional().describe("Product name, barcode or HS code (partial match)."),
    category: z.string().trim().min(1).max(100).optional().describe("Category name (partial match)."),
    max_stock: z.number().optional().describe("Only stock-tracked products with stock at or below this (in the product's default unit). Use for low-stock checks."),
    include_disabled: z.boolean().default(false),
    sort: z.enum(["name", "stock_low", "stock_high", "price_high"]).default("name"),
    limit: limit(20, 100),
    offset,
  },
  async run(args, db) {
    const p = new Params();
    const where = [`p."tenantId" = $1`, `NOT p."isDeleted"`];
    if (!args.include_disabled) where.push(`p."isEnable"`);
    if (args.query) {
      const q = p.add(containsPattern(args.query));
      where.push(`(p.name ILIKE ${q} OR p.barcode ILIKE ${q} OR p."hsCode" ILIKE ${q})`);
    }
    if (args.category) where.push(`c.name ILIKE ${p.add(containsPattern(args.category))}`);
    if (args.max_stock !== undefined) {
      where.push(`p."isStockTrackable"`, `COALESCE(s.qty, 0) / NULLIF(COALESCE(piu."conversionFactor", 1), 0) <= ${p.add(args.max_stock)}`);
    }

    const from = `
      FROM "Product" p
      LEFT JOIN "Category" c ON c.id = p."categoryId" AND c."tenantId" = $1
      LEFT JOIN "Brand" bd ON bd.id = p."brandId" AND bd."tenantId" = $1
      LEFT JOIN "ProductInternalUom" piu ON piu.id = p."defaultProductInternalUomId" AND piu."tenantId" = $1
      LEFT JOIN "InternalUom" du ON du.id = piu."internalUomId" AND du."tenantId" = $1
      LEFT JOIN LATERAL (
        SELECT sum(CASE WHEN m.direction = 'IN' THEN m.quantity ELSE -m.quantity END) AS qty
          FROM "StockMoves" m WHERE m."tenantId" = $1 AND m."productId" = p.id
      ) s ON true
      WHERE ${where.join(" AND ")}`;

    const [count] = await db.query<{ n: number }>(`SELECT count(*) AS n ${from}`, p.values);
    const limitP = p.add(args.limit);
    const offsetP = p.add(args.offset);
    const products = await db.query(
      `SELECT p.name, c.name AS category, bd.name AS brand, p.barcode, p."hsCode",
              p.price AS "salePrice", p."purchasePrice", p."taxRate", p."isEnable" AS enabled,
              p."isStockTrackable" AS "stockTracked",
              du.name AS "defaultUnit",
              CASE WHEN p."isStockTrackable"
                   THEN round(COALESCE(s.qty, 0) / NULLIF(COALESCE(piu."conversionFactor", 1), 0), 3) END AS "stockInDefaultUnit",
              CASE WHEN p."isStockTrackable" THEN COALESCE(s.qty, 0) END AS "stockInBaseUnits",
              COALESCE(piu."conversionFactor", 1) AS "baseUnitsPerDefaultUnit"
       ${from}
       ORDER BY ${SORTS[args.sort]}
       LIMIT ${limitP} OFFSET ${offsetP}`,
      p.values,
    );

    return {
      currency: currency(),
      totalMatching: count?.n ?? 0,
      products,
      returned: products.length,
      offset: args.offset,
      hasMore: args.offset + products.length < (count?.n ?? 0),
      note: "Stock = all stock movements in minus out, across branches. Untracked products show no stock figure.",
    };
  },
});

export const productTools = [searchProducts];
