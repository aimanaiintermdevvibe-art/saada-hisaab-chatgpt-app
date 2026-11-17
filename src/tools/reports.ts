import { todayLocal, yearStartLocal } from "../db/time.js";
import {
  CODES,
  integrityWarning,
  loadAccounts,
  unbalancedEntries,
  type AccountRow,
  type AccountType,
} from "./accounting-data.js";
import { checkRange, currency, fromDate, round2, toDate } from "./common.js";
import { defineTool } from "./framework.js";

const JOURNAL_BASIS =
  "Built from posted journal entries (the accounting books). Invoice-based figures from get_sales_summary " +
  "can differ, e.g. for invoices recorded before accounting postings were enabled.";

interface Line {
  code: string;
  name: string;
  amount: number;
}

/** Groups accounts by their second-level heading, keeping accounts with a non-zero amount. */
function grouped(accounts: AccountRow[], amountOf: (a: AccountRow) => number) {
  const groups = new Map<string, Line[]>();
  for (const a of accounts) {
    const amount = round2(amountOf(a));
    if (amount === 0) continue;
    const list = groups.get(a.group) ?? [];
    list.push({ code: a.code, name: a.name, amount });
    groups.set(a.group, list);
  }
  const result = [...groups.entries()].map(([group, lines]) => ({
    group,
    total: round2(lines.reduce((s, l) => s + l.amount, 0)),
    accounts: lines,
  }));
  return { total: round2(result.reduce((s, g) => s + g.total, 0)), groups: result };
}

const ownDebitSide = (a: AccountRow) => a.ownDebit - a.ownCredit;
const ownCreditSide = (a: AccountRow) => a.ownCredit - a.ownDebit;
const ofType = (accounts: AccountRow[], type: AccountType) => accounts.filter((a) => a.type === type);
const isCogs = (a: AccountRow) => a.codePath.includes(CODES.COGS) || /cost of goods|^cogs$/i.test(a.name);

const getTrialBalance = defineTool({
  name: "get_trial_balance",
  title: "Get trial balance",
  description:
    "Returns the trial balance as of a date: each account's net debit or credit balance, and the debit and " +
    "credit totals, which should be equal. Use it to check the books, or when an accountant asks for a trial balance.",
  input: {
    as_of: toDate("Defaults to today."),
  },
  async run(args, db) {
    const asOf = args.as_of ?? todayLocal();
    const accounts = await loadAccounts(db, { to: asOf });
    const rows = accounts
      .map((a) => {
        const net = round2(a.ownDebit - a.ownCredit);
        return { code: a.code, name: a.name, type: a.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
      })
      .filter((r) => r.debit !== 0 || r.credit !== 0);
    const totalDebit = round2(rows.reduce((s, r) => s + r.debit, 0));
    const totalCredit = round2(rows.reduce((s, r) => s + r.credit, 0));
    const difference = round2(totalDebit - totalCredit);
    const warning = integrityWarning(await unbalancedEntries(db, { to: asOf }));
    return {
      asOf,
      currency: currency(),
      accounts: rows,
      totalDebit,
      totalCredit,
      difference,
      isBalanced: difference === 0,
      ...(warning ? { warning } : {}),
      basis: JOURNAL_BASIS,
    };
  },
});

const getProfitAndLoss = defineTool({
  name: "get_profit_and_loss",
  title: "Get profit and loss",
  description:
    "Returns the profit and loss (income statement) for a period: income by account, cost of goods sold, " +
    "gross profit, other expenses by account, and net profit. Use it for 'did I make a profit', 'what are " +
    "my expenses', or 'P&L for last month'.",
  input: {
    from: fromDate("Defaults to the start of the current year."),
    to: toDate("Defaults to today."),
  },
  async run(args, db) {
    const from = args.from ?? yearStartLocal();
    const to = args.to ?? todayLocal();
    checkRange(from, to);
    const accounts = await loadAccounts(db, { from, to });

    // Income: credits increase it. Contra accounts (Sale Returns, Sales Discount) net off naturally.
    const income = grouped(ofType(accounts, "INCOME"), ownCreditSide);
    const expenseAccounts = ofType(accounts, "EXPENSE");
    const cogs = grouped(expenseAccounts.filter(isCogs), ownDebitSide);
    const otherExpenses = grouped(expenseAccounts.filter((a) => !isCogs(a)), ownDebitSide);
    const grossProfit = round2(income.total - cogs.total);
    const warning = integrityWarning(await unbalancedEntries(db, { from, to }));

    return {
      period: { from, to },
      currency: currency(),
      income,
      costOfGoodsSold: cogs,
      grossProfit,
      expenses: otherExpenses,
      netProfit: round2(grossProfit - otherExpenses.total),
      ...(warning ? { warning } : {}),
      basis: JOURNAL_BASIS,
    };
  },
});

const getBalanceSheet = defineTool({
  name: "get_balance_sheet",
  title: "Get balance sheet",
  description:
    "Returns the balance sheet as of a date: assets, liabilities and equity grouped by heading (e.g. Current " +
    "Assets), with profit to date shown under equity. Use it for 'what do I own and owe' or 'financial position'.",
  input: {
    as_of: toDate("Defaults to today."),
  },
  async run(args, db) {
    const asOf = args.as_of ?? todayLocal();
    const accounts = await loadAccounts(db, { to: asOf });

    const assets = grouped(ofType(accounts, "ASSET"), ownDebitSide);
    const liabilities = grouped(ofType(accounts, "LIABILITY"), ownCreditSide);
    const equityAccounts = grouped(ofType(accounts, "EQUITY"), ownCreditSide);

    // Income and expense accounts are not closed into equity in Saada Hisaab, so add profit to date.
    const profitToDate = round2(
      ofType(accounts, "INCOME").reduce((s, a) => s + ownCreditSide(a), 0) -
        ofType(accounts, "EXPENSE").reduce((s, a) => s + ownDebitSide(a), 0),
    );
    const equity = {
      total: round2(equityAccounts.total + profitToDate),
      groups: equityAccounts.groups,
      profitToDate,
    };
    const liabilitiesAndEquity = round2(liabilities.total + equity.total);
    const difference = round2(assets.total - liabilitiesAndEquity);
    const warning = integrityWarning(await unbalancedEntries(db, { to: asOf }));

    return {
      asOf,
      currency: currency(),
      assets,
      liabilities,
      equity,
      totalAssets: assets.total,
      totalLiabilitiesAndEquity: liabilitiesAndEquity,
      difference,
      isBalanced: difference === 0,
      ...(warning ? { warning } : {}),
      basis: JOURNAL_BASIS,
    };
  },
});

export const reportTools = [getTrialBalance, getProfitAndLoss, getBalanceSheet];
