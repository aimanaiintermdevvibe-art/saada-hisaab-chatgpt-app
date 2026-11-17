import { Params, type TenantDb } from "../db/tenant.js";
import { dateRangeConditions } from "../db/time.js";
import { round2 } from "./common.js";

export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
export type Nature = "DEBIT" | "CREDIT";

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  /** The side on which the account normally carries its balance. */
  nature: Nature;
  isLedger: boolean;
  isActive: boolean;
  hasChildren: boolean;
  parentCode: string | null;
  /** Second-level heading the account sits under, e.g. "Current Assets" or "Operating Expenses". */
  group: string;
  /** Codes from the top-level account down to this one. */
  codePath: string[];
  /** Journal lines posted directly to this account. */
  ownDebit: number;
  ownCredit: number;
  /** This account plus all of its sub-accounts. */
  totalDebit: number;
  totalCredit: number;
}

/** Standard Saada Hisaab chart-of-accounts codes (same template in every tenant). */
export const CODES = { CASH: "10101", BANKS: "10103", RECEIVABLES: "10102", PAYABLES: "20101", COGS: "402" } as const;

/**
 * Loads every account of the tenant with debit/credit totals from journal lines whose
 * entry was posted within [from, to] (either bound optional).
 */
export async function loadAccounts(db: TenantDb, range: { from?: string; to?: string } = {}): Promise<AccountRow[]> {
  const p = new Params();
  const dateConds = dateRangeConditions('je."postedAt"', (v) => p.add(v), range.from, range.to);
  return db.query<AccountRow>(
    `WITH RECURSIVE tree AS (
       SELECT a.id, 0 AS level, NULL::text AS grp, ARRAY[a.id] AS ids, ARRAY[a.code] AS codes
         FROM "Account" a
        WHERE a."tenantId" = $1 AND a."parentId" IS NULL
       UNION ALL
       SELECT c.id, t.level + 1, COALESCE(t.grp, c.name), t.ids || c.id, t.codes || c.code
         FROM "Account" c
         JOIN tree t ON c."parentId" = t.id
        WHERE c."tenantId" = $1 AND t.level < 12
     ),
     lt AS (
       SELECT jl."accountId", sum(jl.debit) AS debit, sum(jl.credit) AS credit
         FROM "JournalLine" jl
         JOIN "JournalEntry" je ON je.id = jl."journalEntryId" AND je."tenantId" = $1
        WHERE jl."tenantId" = $1 ${dateConds.map((c) => `AND ${c}`).join(" ")}
        GROUP BY jl."accountId"
     )
     SELECT a.id, a.code, a.name, a.type::text AS type, a.nature::text AS nature,
            a."isLedger", a."isActive", p.code AS "parentCode",
            COALESCE(t.grp, a.name) AS "group",
            COALESCE(t.codes, ARRAY[a.code]) AS "codePath",
            EXISTS (SELECT 1 FROM "Account" ch WHERE ch."tenantId" = $1 AND ch."parentId" = a.id) AS "hasChildren",
            COALESCE(own.debit, 0) AS "ownDebit",
            COALESCE(own.credit, 0) AS "ownCredit",
            COALESCE(roll.debit, own.debit, 0) AS "totalDebit",
            COALESCE(roll.credit, own.credit, 0) AS "totalCredit"
       FROM "Account" a
       LEFT JOIN tree t ON t.id = a.id
       LEFT JOIN "Account" p ON p.id = a."parentId" AND p."tenantId" = $1
       LEFT JOIN lt own ON own."accountId" = a.id
       LEFT JOIN LATERAL (
         SELECT sum(l.debit) AS debit, sum(l.credit) AS credit
           FROM tree d
           JOIN lt l ON l."accountId" = d.id
          WHERE a.id = ANY(d.ids)
       ) roll ON t.id IS NOT NULL
      WHERE a."tenantId" = $1
      ORDER BY a.code`,
    p.values,
  );
}

/** Balance on the account's normal side: positive = normal, negative = opposite side. */
export function naturalBalance(nature: Nature, debit: number, credit: number): number {
  return round2(nature === "DEBIT" ? debit - credit : credit - debit);
}

/** Accounts at or under the account with `code`. */
export function under(accounts: AccountRow[], code: string): AccountRow[] {
  return accounts.filter((a) => a.codePath.includes(code));
}

/**
 * Journal entries whose lines do not balance (debits != credits) in the range. A non-zero
 * count explains why a trial balance or balance sheet does not balance.
 */
export async function unbalancedEntries(
  db: TenantDb,
  range: { from?: string; to?: string } = {},
): Promise<{ count: number; netDifference: number }> {
  const p = new Params();
  const dateConds = dateRangeConditions('je."postedAt"', (v) => p.add(v), range.from, range.to);
  const [row] = await db.query<{ count: number; netDifference: number }>(
    `SELECT count(*) AS count, COALESCE(sum(diff), 0) AS "netDifference"
       FROM (
         SELECT sum(jl.debit) - sum(jl.credit) AS diff
           FROM "JournalEntry" je
           JOIN "JournalLine" jl ON jl."journalEntryId" = je.id AND jl."tenantId" = $1
          WHERE je."tenantId" = $1 ${dateConds.map((c) => `AND ${c}`).join(" ")}
          GROUP BY je.id
         HAVING sum(jl.debit) <> sum(jl.credit)
       ) x`,
    p.values,
  );
  return row ?? { count: 0, netDifference: 0 };
}

export function integrityWarning(u: { count: number; netDifference: number }): string | undefined {
  if (u.count === 0) return undefined;
  return (
    `${u.count} journal entr${u.count === 1 ? "y has" : "ies have"} lines that do not balance ` +
    `(net difference ${round2(u.netDifference)}). This is a data issue in Saada Hisaab's postings, ` +
    `so totals that depend on those entries may be off by that amount.`
  );
}
