import { z } from "zod";
import { containsPattern, Params } from "../db/tenant.js";
import { dateRangeConditions, localDate, todayLocal, yearStartLocal } from "../db/time.js";
import { checkRange, currency, fromDate, limit, round2, toDate } from "./common.js";
import { defineTool } from "./framework.js";

const listExpenses = defineTool({
  name: "list_expenses",
  title: "List expenses",
  description:
    "Lists expenses recorded in Saada Hisaab's expense module for a period (number, date, payment mode, paid-from " +
    "account, lines by expense account) with totals per expense account. Use it for 'what did I spend on rent' or " +
    "'list my expenses this month'. Costs posted another way (vouchers, payroll, cost of goods sold) appear in " +
    "get_profit_and_loss and get_account_ledger instead.",
  input: {
    from: fromDate("Defaults to the start of the current year."),
    to: toDate("Defaults to today."),
    account: z.string().trim().min(1).max(100).optional().describe("Expense account name or code (partial match), e.g. rent."),
    limit: limit(50, 200),
  },
  async run(args, db) {
    const from = args.from ?? yearStartLocal();
    const to = args.to ?? todayLocal();
    checkRange(from, to);

    const p = new Params();
    const where = [`e."tenantId" = $1`, ...dateRangeConditions("e.date", (v) => p.add(v), from, to)];
    if (args.account) {
      const q = p.add(containsPattern(args.account));
      where.push(`EXISTS (SELECT 1 FROM "ExpenseLine" el JOIN "Account" a ON a.id = el."accountId" AND a."tenantId" = $1
                          WHERE el."tenantId" = $1 AND el."expenseId" = e.id AND (a.name ILIKE ${q} OR a.code ILIKE ${q}))`);
    }
    const expenses = await db.query<{ id: string } & Record<string, unknown>>(
      `SELECT e.id, e."expenseNo", ${localDate("e.date")} AS date, e."expenseType", e."paymentMode"::text AS "paymentMode",
              pa.name AS "paidFrom", e."totalAmount", (e."sourceRecurringExpenseId" IS NOT NULL) AS recurring
         FROM "Expense" e
         LEFT JOIN "Account" pa ON pa.id = e."paidFromAccountId" AND pa."tenantId" = $1
        WHERE ${where.join(" AND ")}
        ORDER BY e.date DESC, e.id
        LIMIT ${p.add(args.limit)}`,
      p.values,
    );

    const lines = expenses.length
      ? await db.query<{ expenseId: string; code: string; account: string; amount: number; narration: string | null }>(
          `SELECT el."expenseId", a.code, a.name AS account, el.amount, el.narration
             FROM "ExpenseLine" el
             JOIN "Account" a ON a.id = el."accountId" AND a."tenantId" = $1
            WHERE el."tenantId" = $1 AND el."expenseId" = ANY($2::text[])
            ORDER BY el.id`,
          [expenses.map((e) => e.id)],
        )
      : [];

    const byAccount = new Map<string, { code: string; account: string; amount: number }>();
    for (const l of lines) {
      const e = byAccount.get(l.code) ?? { code: l.code, account: l.account, amount: 0 };
      e.amount = round2(e.amount + l.amount);
      byAccount.set(l.code, e);
    }

    return {
      period: { from, to },
      currency: currency(),
      count: expenses.length,
      total: round2(expenses.reduce((s, e) => s + Number(e.totalAmount), 0)),
      byAccount: [...byAccount.values()].sort((a, b) => b.amount - a.amount),
      expenses: expenses.map(({ id, ...e }) => ({
        ...e,
        lines: lines.filter((l) => l.expenseId === id).map(({ expenseId: _x, ...l }) => l),
      })),
    };
  },
});

export const expenseTools = [listExpenses];
