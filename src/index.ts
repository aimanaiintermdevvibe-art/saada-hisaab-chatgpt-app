import { createHash, timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { AuthError, resolveCallerByUsername } from "./auth/caller.js";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { buildServer } from "./server.js";

const HOST = "127.0.0.1";

// ---------- Dev access key (until OAuth): MCP endpoint is /mcp/<DEV_ACCESS_KEY> ----------
const digest = (s: string) => createHash("sha256").update(s).digest();
const expectedKey = digest(config.DEV_ACCESS_KEY);
const keyMatches = (key: unknown) => typeof key === "string" && timingSafeEqual(digest(key), expectedKey);

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

const app = createMcpExpressApp({ host: HOST, allowedHosts: config.ALLOWED_HOSTS });

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/mcp/:key", async (req: Request, res: Response) => {
  if (!keyMatches(req.params.key)) return jsonRpcError(res, 404, "Not found");

  let caller;
  try {
    caller = await resolveCallerByUsername(config.DEV_USERNAME);
  } catch (err) {
    if (err instanceof AuthError) return jsonRpcError(res, 403, err.message);
    console.error(JSON.stringify({ level: "error", msg: "caller lookup failed", error: (err as Error).message }));
    return jsonRpcError(res, 503, "Saada Hisaab is temporarily unavailable.");
  }

  // Stateless: a fresh server + transport per request, bound to this caller's tenant.
  const server = buildServer(caller);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "MCP request failed", error: (err as Error).message }));
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});

// Stateless server: no SSE stream or session to resume/delete.
app.all("/mcp/:key", (_req, res) => jsonRpcError(res, 405, "Method not allowed"));
app.use((_req, res) => jsonRpcError(res, 404, "Not found"));

async function main(): Promise<void> {
  // Fail fast if the database or the dev user is not usable.
  const caller = await resolveCallerByUsername(config.DEV_USERNAME);
  // Express 5 calls this callback with an error too (e.g. port already in use).
  const httpServer = app.listen(config.PORT, HOST, (error?: Error) => {
    if (error) {
      const inUse = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
      console.error(
        inUse
          ? `Failed to start: port ${config.PORT} is already in use. Stop the other server (or change PORT in .env).`
          : `Failed to start: ${error.message}`,
      );
      process.exit(1);
    }
    const masked = `${config.DEV_ACCESS_KEY.slice(0, 4)}…`;
    console.error(`Saada Hisaab MCP server listening on http://localhost:${config.PORT}`);
    console.error(`  MCP endpoint: http://localhost:${config.PORT}/mcp/<DEV_ACCESS_KEY from .env> (${masked})`);
    console.error(`  Acting as dev user "${caller.username}" of "${caller.businessName}" (tenant ${caller.tenantId.slice(0, 8)})`);
    console.error(`  Allowed hosts: ${config.ALLOWED_HOSTS.join(", ")}`);
  });

  const shutdown = () => {
    httpServer.close(() => void pool.end().finally(() => process.exit(0)));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`Failed to start: ${(err as Error).message}`);
  process.exit(1);
});
