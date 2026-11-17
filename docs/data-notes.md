# Data notes: sh_db

Findings from the restored `sh_db.backup` (PostgreSQL 17.4, 86 tables, 10 tenants, data from 2025-10 to 2026-08)
that affect what the ChatGPT app reports. Items 1 and 2 look like bugs in Saada Hisaab worth raising with DevVibe.

## 1. Journal entries with missing lines (45 entries)

In these entries the lines' debits do not equal the credits, although the entry header totals do.
One side of the posting was never written:

| Entry type | Entries | What is missing | Net effect (debit − credit) |
|---|---|---|---|
| Purchase (`P`) | 32 | debit lines (e.g. Inventory) | −69,615.11 |
| Purchase return (`PR`) | 11 | credit lines | +8,925.33 |
| Cash payment voucher (`CPV`) | 1 | debit line | −50,000.00 |
| Bank payment voucher (`BPV`) | 1 | debit line | −30,000.00 |

Example: a purchase entry with header totals 184.80 / 184.80 has only the line *Cash credit 184.80*.

**Effect:** trial balance and balance sheet do not balance; the difference equals these entries exactly.
The app reports the difference and warns the user instead of hiding it.

Find them:
```sql
SELECT je.id, je."refType", je."tenantId", sum(jl.debit) AS debit, sum(jl.credit) AS credit
  FROM "JournalEntry" je JOIN "JournalLine" jl ON jl."journalEntryId" = je.id
 GROUP BY je.id HAVING sum(jl.debit) <> sum(jl.credit);
```

## 2. Customers and vendors not linked to ledger accounts

18 of 34 customers (`Buyer.accountId`) and 8 of 17 vendors (`Vendor.accountId`) have no ledger account,
so their balances cannot come from the books. The app computes outstanding amounts from invoices instead.

## 3. Invoices without journal entries (142 of 385)

Mostly invoices created before accounting postings existed (e.g. 107 Demo Account invoices from October 2025).
Invoice-based sales totals are therefore higher than income in the profit and loss. Expected; each tool states
its basis.

## 4. Invoices without payment status (188 of 385)

`Invoice.paymentStatus` is empty on older invoices, so "outstanding invoices" only covers invoices marked `DUE`.

## Conventions the app relies on

- Timestamps are stored in UTC (sales cluster at 05:00–14:00 stored = 10:00–19:00 in Pakistan). Reports use
  `Asia/Karachi` calendar days.
- Every tenant uses the same chart-of-accounts template: `10101` Cash, `10102` Accounts Receivable,
  `10103` Banks, `20101` Accounts Payable, `402` Cost of Goods Sold.
- A sale counts when `status = 'COMPLETE'` and `isDeleted = false`.
- `netAmount = grossAmount − discount + tax + extraTax − extraDiscount` holds for all 385 invoices.
- Stock = sum of `StockMoves` in − out, in base units; divide by `ProductInternalUom.conversionFactor` for the
  product's default unit.
