import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Caller } from "../auth/caller.js";
import { withTenant, type TenantDb } from "../db/tenant.js";

/** An error whose message is safe and useful to show the user (e.g. "invoice not found"). */
export class ToolError extends Error {}

export interface ReadToolSpec<S extends z.ZodRawShape> {
  name: string;
  title: string;
  /** What ChatGPT reads to decide when to call the tool. Say what it returns and when to use it. */
  description: string;
  input: S;
  run: (args: z.infer<z.ZodObject<S>>, db: TenantDb, caller: Caller) => Promise<Record<string, unknown>>;
}

/** Keeps each tool's argument types precise where it is written; erases them for the registry list. */
export function defineTool<S extends z.ZodRawShape>(spec: ReadToolSpec<S>): ReadToolSpec<z.ZodRawShape> {
  return spec as unknown as ReadToolSpec<z.ZodRawShape>;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** Registers a read-only tool whose queries all run inside the caller's tenant scope. */
export function registerReadTool(server: McpServer, caller: Caller, spec: ReadToolSpec<z.ZodRawShape>): void {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.input,
      annotations: { title: spec.title, ...READ_ONLY },
    },
    async (args: unknown): Promise<CallToolResult> => {
      const started = Date.now();
      try {
        const data = await withTenant(caller.tenantId, (db) =>
          spec.run(args as z.infer<z.ZodObject<z.ZodRawShape>>, db, caller),
        );
        log(spec.name, caller, started, "ok");
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
      } catch (err) {
        if (err instanceof ToolError) {
          log(spec.name, caller, started, "user_error");
          return { isError: true, content: [{ type: "text", text: err.message }] };
        }
        log(spec.name, caller, started, "error", err);
        return {
          isError: true,
          content: [{ type: "text", text: "Saada Hisaab could not load this data right now. Please try again." }],
        };
      }
    },
  );
}

function log(tool: string, caller: Caller, started: number, outcome: string, err?: unknown): void {
  const entry: Record<string, unknown> = {
    level: outcome === "error" ? "error" : "info",
    tool,
    tenant: caller.tenantId.slice(0, 8),
    ms: Date.now() - started,
    outcome,
  };
  if (err) entry.error = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify(entry));
}
