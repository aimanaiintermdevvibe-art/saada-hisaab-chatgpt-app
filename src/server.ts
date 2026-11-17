import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Caller } from "./auth/caller.js";
import { config } from "./config.js";
import { accountTools } from "./tools/accounts.js";
import { businessTools } from "./tools/business.js";
import { expenseTools } from "./tools/expenses.js";
import { registerReadTool } from "./tools/framework.js";
import { partyTools } from "./tools/parties.js";
import { productTools } from "./tools/products.js";
import { purchaseTools } from "./tools/purchases.js";
import { reportTools } from "./tools/reports.js";
import { salesTools } from "./tools/sales.js";

export const ALL_TOOLS = [
  ...businessTools,
  ...salesTools,
  ...purchaseTools,
  ...partyTools,
  ...accountTools,
  ...reportTools,
  ...expenseTools,
  ...productTools,
];

const INSTRUCTIONS = `Saada Hisaab is an accounting, invoicing and inventory app for businesses in Pakistan (FBR digital invoicing).
These tools read the signed-in user's own business data. They are read-only: they cannot create, change or delete anything.
- Amounts are in ${config.CURRENCY}. Dates are YYYY-MM-DD in ${config.BUSINESS_TIMEZONE} time.
- If you do not know which period has data, call get_business_profile first; it returns the data date range.
- Sales tools (list_sales_invoices, get_sales_summary) count invoices. Accounting reports (get_profit_and_loss,
  get_balance_sheet, get_trial_balance, get_account_ledger) use journal entries. The two can differ; say which one you used.
- If a result contains "warning", tell the user about it in plain words.
- Present money with thousands separators and the currency. Keep invoice numbers exactly as returned.`;

/** Builds an MCP server whose tools all act for `caller` and are scoped to the caller's tenant. */
export function buildServer(caller: Caller): McpServer {
  const server = new McpServer(
    { name: "saada-hisaab", title: "Saada Hisaab", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );
  for (const tool of ALL_TOOLS) registerReadTool(server, caller, tool);
  return server;
}
