import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { signToken } from "../src/auth/jwt.js";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { USER_A, USER_B } from "./helpers.js";

// The full OAuth flow over real HTTP, the way ChatGPT runs it:
// discover -> register -> /authorize (login page) -> /login -> code -> /token (PKCE) -> /mcp with a bearer token.

const REDIRECT = "http://localhost:9999/callback";
const PASSWORD = config.DEV_LOGIN_PASSWORD!;

let base = "";
let server: http.Server;
let handler: http.RequestListener = () => {};
/** A fresh app instance on the same address: like a restart (all in-memory state gone). */
const restart = () => {
  handler = createApp({ publicBaseUrl: base });
};

beforeAll(async () => {
  expect(config.LOGIN_MODE).toBe("dev");
  server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  restart();
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ---------- helpers ----------

const json = async (path: string, init?: RequestInit) => {
  const res = await fetch(base + path, init);
  return { res, body: (await res.json()) as any };
};

async function register(extra: Record<string, unknown> = {}) {
  return json("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Test Client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post", ...extra }),
  });
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function openLoginPage(clientId: string, challenge: string, params: Record<string, string> = {}) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    scope: "saada.read",
    resource: `${base}/mcp`,
    ...params,
  });
  return fetch(`${base}/authorize?${q}`, { redirect: "manual" });
}

const requestTokenFrom = (html: string) => html.match(/name="request" value="([^"]+)"/)![1]!;

async function submitLogin(requestToken: string, username: string, password: string) {
  return fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request: requestToken, username, password }),
  });
}

async function token(params: Record<string, string>) {
  return json("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

/** Runs the whole flow and returns tokens plus what is needed to reuse them. */
async function signIn(username: string, opts: { publicClient?: boolean } = {}) {
  const reg = await register(opts.publicClient ? { token_endpoint_auth_method: "none" } : {});
  expect(reg.res.status, JSON.stringify(reg.body)).toBe(201);
  const client = reg.body;
  const { verifier, challenge } = pkce();
  const page = await openLoginPage(client.client_id, challenge);
  expect(page.status).toBe(200);
  const login = await submitLogin(requestTokenFrom(await page.text()), username, PASSWORD);
  expect(login.status).toBe(302);
  const location = new URL(login.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(REDIRECT);
  expect(location.searchParams.get("state")).toBe("state-123");
  const code = location.searchParams.get("code")!;
  const secret = client.client_secret ? { client_secret: client.client_secret } : {};
  const tok = await token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    ...secret,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    resource: `${base}/mcp`,
  });
  expect(tok.res.status, JSON.stringify(tok.body)).toBe(200);
  return { client, secret, code, verifier, tokens: tok.body };
}

async function mcp(accessToken: string | undefined, method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  return { res, result: data ? JSON.parse(data.slice(6)).result : undefined };
}

// ---------- tests ----------

describe("discovery (what ChatGPT reads first)", () => {
  it("publishes authorization server metadata with PKCE S256 and registration", async () => {
    const { body } = await json("/.well-known/oauth-authorization-server");
    expect(body.issuer).toBe(`${base}/`);
    expect(body.authorization_endpoint).toBe(`${base}/authorize`);
    expect(body.token_endpoint).toBe(`${base}/token`);
    expect(body.registration_endpoint).toBe(`${base}/register`);
    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body.token_endpoint_auth_methods_supported).toEqual(expect.arrayContaining(["none", "client_secret_post"]));
    expect(body.scopes_supported).toEqual(["saada.read"]);
  });

  it.each(["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"])(
    "publishes protected resource metadata at %s",
    async (path) => {
      const { body } = await json(path);
      expect(body.resource).toBe(`${base}/mcp`);
      expect(body.authorization_servers).toEqual([`${base}/`]);
    },
  );

  it("answers an unauthenticated MCP request with 401 pointing to the metadata", async () => {
    const { res } = await mcp(undefined, "tools/list");
    expect(res.status).toBe(401);
    const header = res.headers.get("www-authenticate") ?? "";
    expect(header).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    expect(header).toContain(`scope="saada.read"`);
  });
});

describe("client registration", () => {
  it("rejects redirect URIs outside the allowlist", async () => {
    const { res, body } = await register({ redirect_uris: ["https://evil.example.com/callback"] });
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("switches unsupported client_secret_basic to client_secret_post and says so", async () => {
    const { res, body } = await register({ token_endpoint_auth_method: "client_secret_basic" });
    expect(res.status).toBe(201);
    expect(body.token_endpoint_auth_method).toBe("client_secret_post");
    expect(body.client_secret).toBeTruthy();
  });

  it("keeps working after a restart (stateless registrations)", async () => {
    const { body: client } = await register();
    restart();
    const page = await openLoginPage(client.client_id, pkce().challenge);
    expect(page.status).toBe(200);
  });
});

describe("sign-in and tool calls", () => {
  it("signs in, then calls tools as that user's business", async () => {
    const { tokens } = await signIn(USER_A);
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.refresh_token).toBeTruthy();

    const list = await mcp(tokens.access_token, "tools/list");
    expect(list.res.status).toBe(200);
    expect(list.result.tools).toHaveLength(16);
    expect(list.result.tools[0]._meta.securitySchemes).toEqual([{ type: "oauth2", scopes: ["saada.read"] }]);

    const profile = await mcp(tokens.access_token, "tools/call", { name: "get_business_profile", arguments: {} });
    expect(profile.result.structuredContent.business.businessName).toBe("Demo Account");
  });

  it("each user only reaches their own business", async () => {
    const { tokens } = await signIn(USER_B);
    const profile = await mcp(tokens.access_token, "tools/call", { name: "get_business_profile", arguments: {} });
    expect(profile.result.structuredContent.business.businessName).toBe("ABC Traders");
  });

  it("works for public clients (no secret, PKCE only)", async () => {
    const { client, tokens } = await signIn(USER_A, { publicClient: true });
    expect(client.client_secret).toBeUndefined();
    expect((await mcp(tokens.access_token, "tools/list")).res.status).toBe(200);
  });

  it("shows the login page with anti-framing headers", async () => {
    const { body: client } = await register();
    const page = await openLoginPage(client.client_id, pkce().challenge);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain("Sign in to Saada Hisaab");
  });
});

describe("sign-in rejects bad credentials", () => {
  async function loginPageToken() {
    const { body: client } = await register();
    return requestTokenFrom(await (await openLoginPage(client.client_id, pkce().challenge)).text());
  }

  it("wrong password: stays on the page with an error, no code", async () => {
    const res = await submitLogin(await loginPageToken(), USER_A, "wrong-password");
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Incorrect username or password.");
  });

  it("unknown user: same message (does not reveal which part was wrong)", async () => {
    const res = await submitLogin(await loginPageToken(), "no-such-user", PASSWORD);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Incorrect username or password.");
  });

  it("tampered sign-in form: refused", async () => {
    const res = await submitLogin(`${await loginPageToken()}x`, USER_A, PASSWORD);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("expired");
  });
});

describe("token rules", () => {
  it("an authorization code works once, and only with the right PKCE verifier", async () => {
    const { client, secret, code, verifier } = await signIn(USER_A);
    const base_ = { grant_type: "authorization_code", client_id: client.client_id, ...secret, code, redirect_uri: REDIRECT };
    const reused = await token({ ...base_, code_verifier: verifier });
    expect(reused.body.error).toBe("invalid_grant");

    // A fresh code with a wrong verifier.
    const { verifier: _right, challenge } = pkce();
    const page = await openLoginPage(client.client_id, challenge);
    const login = await submitLogin(requestTokenFrom(await page.text()), USER_A, PASSWORD);
    const freshCode = new URL(login.headers.get("location")!).searchParams.get("code")!;
    const wrong = await token({ ...base_, code: freshCode, code_verifier: pkce().verifier });
    expect(wrong.body.error).toBe("invalid_grant");
  });

  it("refresh gives a working new access token; token types cannot be swapped", async () => {
    const { client, secret, tokens } = await signIn(USER_A);
    const refreshed = await token({ grant_type: "refresh_token", client_id: client.client_id, ...secret, refresh_token: tokens.refresh_token });
    expect(refreshed.res.status).toBe(200);
    expect((await mcp(refreshed.body.access_token, "tools/list")).res.status).toBe(200);

    const accessAsRefresh = await token({ grant_type: "refresh_token", client_id: client.client_id, ...secret, refresh_token: tokens.access_token });
    expect(accessAsRefresh.body.error).toBe("invalid_grant");
    expect((await mcp(tokens.refresh_token, "tools/list")).res.status).toBe(401);
  });

  it("rejects tampered tokens and tokens issued for another server", async () => {
    const { tokens } = await signIn(USER_A);
    expect((await mcp(`${tokens.access_token}x`, "tools/list")).res.status).toBe(401);

    const otherAudience = await signToken(
      "access",
      { cid: "x", scope: "saada.read" },
      { issuer: base, subject: "someone", audience: "https://other-server.example/mcp", ttlSeconds: 600 },
    );
    expect((await mcp(otherAudience, "tools/list")).res.status).toBe(401);
  });

  it("refuses to issue tokens for a different resource", async () => {
    const { body: client } = await register();
    const res = await openLoginPage(client.client_id, pkce().challenge, { resource: "https://other-server.example/mcp" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });
});
