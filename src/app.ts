import { createHash, timingSafeEqual } from "node:crypto";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { AuthError, resolveCallerById, resolveCallerByUsername, type Caller } from "./auth/caller.js";
import { createLoginVerifier } from "./auth/login.js";
import { SaadaOAuthProvider } from "./auth/oauth-provider.js";
import { SCOPE_READ, SUPPORTED_SCOPES } from "./auth/scopes.js";
import { config } from "./config.js";
import { buildServer } from "./server.js";

export interface AppOptions {
  /** Public address of this server (the OAuth issuer). Defaults to config; tests pass their own. */
  publicBaseUrl?: string;
}

const log = (entry: Record<string, unknown>) => console.error(JSON.stringify(entry));

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

/** Runs one MCP request (stateless: a fresh server per request) as the caller `getCaller` returns. */
function mcpHandler(getCaller: (req: Request) => Promise<Caller>) {
  return async (req: Request, res: Response) => {
    let caller: Caller;
    try {
      caller = await getCaller(req);
    } catch (err) {
      if (err instanceof AuthError) return jsonRpcError(res, 403, err.message);
      log({ level: "error", msg: "caller lookup failed", error: (err as Error).message });
      return jsonRpcError(res, 503, "Saada Hisaab is temporarily unavailable.");
    }
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
      log({ level: "error", msg: "MCP request failed", error: (err as Error).message });
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  };
}

/** The access key from /mcp/<key>. A wildcard, because generated keys (e.g. Render's base64) may contain "/". */
function accessKeyOf(req: Request): string {
  const raw: unknown = req.params.key;
  return Array.isArray(raw) ? raw.join("/") : String(raw ?? "");
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export function createApp(options: AppOptions = {}) {
  const base = (options.publicBaseUrl ?? config.PUBLIC_BASE_URL).replace(/\/+$/, "");
  const mcpUrl = `${base}/mcp`;
  const provider = new SaadaOAuthProvider(
    { issuer: base, resource: mcpUrl, redirectHosts: config.OAUTH_REDIRECT_HOSTS },
    createLoginVerifier(),
  );

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY || false);

  // Before Host checking: hosting platforms probe the health check with their own internal Host header.
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // DNS-rebinding protection: only accept requests addressed to our own host names.
  app.use(hostHeaderValidation([...new Set([...config.ALLOWED_HOSTS, new URL(base).hostname])]));
  app.use(express.json({ limit: "1mb" }));

  // ---------- OAuth: discovery, client registration, /authorize, /token ----------
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(base),
      resourceServerUrl: new URL(mcpUrl),
      scopesSupported: SUPPORTED_SCOPES,
      resourceName: "Saada Hisaab",
      // Our client store issues signed client IDs, and secrets that never expire (see SaadaOAuthProvider).
      clientRegistrationOptions: { clientIdGeneration: false, clientSecretExpirySeconds: 0 },
    }),
  );
  // The SDK serves resource metadata at /.well-known/oauth-protected-resource/mcp; some clients ask at the root.
  const protectedResourceMetadata = {
    resource: mcpUrl,
    authorization_servers: [new URL(base).href],
    scopes_supported: SUPPORTED_SCOPES,
    resource_name: "Saada Hisaab",
  };
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json(protectedResourceMetadata);
  });

  // The login form posted from our /authorize page.
  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
  app.post("/login", loginLimiter, express.urlencoded({ extended: false, limit: "16kb" }), (req, res, next) => {
    provider.handleLogin((req.body ?? {}) as Record<string, unknown>, res).catch(next);
  });

  // ---------- MCP endpoint: needs a valid access token; acts as the signed-in user ----------
  const requireToken = requireBearerAuth({
    verifier: provider,
    requiredScopes: [SCOPE_READ],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(mcpUrl)),
    expectedResource: new URL(mcpUrl),
  });
  app.post("/mcp", requireToken, mcpHandler((req) => resolveCallerById(String(req.auth?.extra?.userId ?? ""))));
  // Stateless server: no SSE stream or session to resume/delete.
  app.all("/mcp", (_req, res) => jsonRpcError(res, 405, "Method not allowed"));

  // ---------- Optional dev shortcut without OAuth: /mcp/<DEV_ACCESS_KEY> ----------
  if (config.DEV_ACCESS_KEY && config.DEV_USERNAME) {
    const expectedKey = digest(config.DEV_ACCESS_KEY);
    const devUsername = config.DEV_USERNAME;
    const checkKey = (req: Request, res: Response, next: NextFunction) =>
      timingSafeEqual(digest(accessKeyOf(req)), expectedKey) ? next() : jsonRpcError(res, 404, "Not found");
    app.post("/mcp/*key", checkKey, mcpHandler(() => resolveCallerByUsername(devUsername)));
    app.all("/mcp/*key", (_req, res) => jsonRpcError(res, 405, "Method not allowed"));
  }

  app.use((_req, res) => jsonRpcError(res, 404, "Not found"));
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log({ level: "error", msg: "unhandled error", error: err.message });
    if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
  });

  return app;
}
