import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response } from "express";
import { AuthError, resolveCallerById } from "./caller.js";
import { clientSecretFor, signToken, verifyToken } from "./jwt.js";
import type { LoginVerifier } from "./login.js";
import { loginPage, messagePage, sendPage } from "./login-page.js";
import { SCOPE_READ, SUPPORTED_SCOPES } from "./scopes.js";

const TTL = { authRequest: 10 * 60, code: 5 * 60, access: 60 * 60, refresh: 30 * 24 * 60 * 60 } as const;

/** Client auth methods the SDK's token endpoint can check (client_secret_basic is not among them). */
const AUTH_METHODS = ["client_secret_post", "none"];

export interface OAuthSettings {
  /** OAuth issuer, e.g. https://saada-hisaab-mcp.onrender.com */
  issuer: string;
  /** The MCP endpoint every token is issued for (its audience), e.g. https://…/mcp */
  resource: string;
  /** Hosts allowed in registered redirect URIs (e.g. chatgpt.com). */
  redirectHosts: string[];
}

/** Client details carried inside the signed client_id. */
type ClientMeta = Pick<
  OAuthClientInformationFull,
  "redirect_uris" | "client_name" | "token_endpoint_auth_method" | "grant_types" | "response_types"
>;
/** A pending sign-in, carried in the login form. */
type AuthRequest = { cid: string; cname?: string; ru: string; cc: string; st?: string; sc: string[] };
/** An authorization code's contents. */
type CodeClaims = { cid: string; ru: string; cc: string; sc: string[] };
/** Access/refresh token contents (the user is `sub`). */
type GrantClaims = { cid: string; scope: string };

const sameUrl = (a: URL | string, b: string) => new URL(a).href.replace(/\/$/, "") === new URL(b).href.replace(/\/$/, "");

/**
 * OAuth 2.1 authorization server for the MCP endpoint (the "embedded" setup in the MCP spec).
 * Stateless: client registrations, codes and tokens are signed tokens, so a restart or a sleeping
 * Render instance never invalidates ChatGPT's registration or a signed-in user.
 * Flow: ChatGPT registers (DCR) -> /authorize shows our login page -> /login checks the password via
 * the LoginVerifier -> redirect with a code -> /token (PKCE) -> access + refresh token for the user.
 */
export class SaadaOAuthProvider implements OAuthServerProvider {
  /** Authorization codes already exchanged (single use), until they expire. */
  private readonly usedCodes = new Map<string, number>();

  constructor(
    private readonly settings: OAuthSettings,
    private readonly loginVerifier: LoginVerifier,
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.getClient(clientId),
      registerClient: (client) => this.registerClient(client),
    };
  }

  // ---------- Client registration (RFC 7591), stateless ----------

  private async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    for (const uri of client.redirect_uris) this.assertAllowedRedirect(uri);
    const method = client.token_endpoint_auth_method;
    const meta: ClientMeta = {
      redirect_uris: client.redirect_uris,
      client_name: client.client_name,
      // RFC 7591 lets the server replace values it does not support; tell the client in the response.
      token_endpoint_auth_method: method && AUTH_METHODS.includes(method) ? method : "client_secret_post",
      grant_types: client.grant_types,
      response_types: client.response_types,
    };
    const clientId = await signToken("client", { m: meta }, { issuer: this.settings.issuer });
    return this.clientInfo(clientId, meta, Math.floor(Date.now() / 1000));
  }

  private async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const payload = await verifyToken<{ m: ClientMeta }>(clientId, "client", { issuer: this.settings.issuer });
    return payload ? this.clientInfo(clientId, payload.m, payload.iat) : undefined;
  }

  private clientInfo(clientId: string, meta: ClientMeta, issuedAt?: number): OAuthClientInformationFull {
    const isPublic = meta.token_endpoint_auth_method === "none";
    return {
      ...meta,
      client_id: clientId,
      client_id_issued_at: issuedAt,
      // Secrets are derived from the id, and never expire (0), so ChatGPT's registration keeps working.
      ...(isPublic ? {} : { client_secret: clientSecretFor(clientId), client_secret_expires_at: 0 }),
    };
  }

  private assertAllowedRedirect(uri: string): void {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      throw new InvalidClientMetadataError(`Invalid redirect_uri: ${uri}`);
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const secure = url.protocol === "https:" || (url.protocol === "http:" && local);
    if (!secure || !this.settings.redirectHosts.includes(url.hostname)) {
      throw new InvalidClientMetadataError(`redirect_uri is not allowed: ${uri}`);
    }
  }

  // ---------- Authorization: show the login page ----------

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && !sameUrl(params.resource, this.settings.resource)) {
      throw new InvalidTargetError("This server only issues tokens for its own MCP endpoint.");
    }
    const requested = (params.scopes ?? []).filter(Boolean);
    const unknown = requested.filter((s) => !SUPPORTED_SCOPES.includes(s));
    if (unknown.length) throw new InvalidScopeError(`Unsupported scope: ${unknown.join(" ")}`);

    const request: AuthRequest = {
      cid: client.client_id,
      cname: client.client_name,
      ru: params.redirectUri,
      cc: params.codeChallenge,
      st: params.state,
      sc: [SCOPE_READ],
    };
    const requestToken = await signToken("authreq", { r: request }, { issuer: this.settings.issuer, ttlSeconds: TTL.authRequest });
    sendPage(res, 200, loginPage({ clientName: client.client_name, requestToken }), new URL(params.redirectUri).origin);
  }

  /** POST /login: check the credentials, then send the browser back to the client with a code. */
  async handleLogin(body: Record<string, unknown>, res: Response): Promise<void> {
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const requestToken = str(body.request);
    const payload = await verifyToken<{ r: AuthRequest }>(requestToken, "authreq", { issuer: this.settings.issuer });
    if (!payload) {
      sendPage(res, 400, messagePage("Sign-in expired", "This sign-in page has expired. Go back to ChatGPT and connect again."));
      return;
    }
    const r = payload.r;
    const username = str(body.username).trim();
    const password = str(body.password);
    const again = (status: number, error: string) =>
      sendPage(res, status, loginPage({ clientName: r.cname, requestToken, error, username }), new URL(r.ru).origin);

    if (!username || !password) return again(400, "Enter your username and password.");
    const result = await this.loginVerifier.verify(username, password);
    if (!result.ok) return again(401, result.message);

    const code = await signToken(
      "code",
      { cid: r.cid, ru: r.ru, cc: r.cc, sc: r.sc } satisfies CodeClaims,
      { issuer: this.settings.issuer, subject: result.userId, ttlSeconds: TTL.code },
    );
    const target = new URL(r.ru);
    target.searchParams.set("code", code);
    if (r.st) target.searchParams.set("state", r.st);
    res.set("Cache-Control", "no-store").redirect(302, target.href);
  }

  // ---------- Token endpoint ----------

  private async readCode(client: OAuthClientInformationFull, code: string) {
    const payload = await verifyToken<CodeClaims>(code, "code", { issuer: this.settings.issuer });
    if (!payload || payload.cid !== client.client_id || !payload.sub || !payload.jti) {
      throw new InvalidGrantError("Invalid or expired authorization code.");
    }
    return payload;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return (await this.readCode(client, code)).cc;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const payload = await this.readCode(client, code);
    if (redirectUri && redirectUri !== payload.ru) throw new InvalidGrantError("redirect_uri does not match the authorization request.");
    if (resource && !sameUrl(resource, this.settings.resource)) throw new InvalidTargetError("Unknown resource.");
    this.useCodeOnce(payload.jti!, payload.exp!);
    await this.assertUserActive(payload.sub!);
    return this.issueTokens(client.client_id, payload.sub!, payload.sc);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const payload = await verifyToken<GrantClaims>(refreshToken, "refresh", { issuer: this.settings.issuer });
    if (!payload || payload.cid !== client.client_id || !payload.sub) throw new InvalidGrantError("Invalid or expired refresh token.");
    const granted = payload.scope.split(" ");
    if (scopes?.some((s) => !granted.includes(s))) throw new InvalidScopeError("Requested scope exceeds the original grant.");
    if (resource && !sameUrl(resource, this.settings.resource)) throw new InvalidTargetError("Unknown resource.");
    await this.assertUserActive(payload.sub);
    return this.issueTokens(client.client_id, payload.sub, scopes?.length ? scopes : granted);
  }

  /** Called on every MCP request (via the SDK's bearer middleware). */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const payload = await verifyToken<GrantClaims>(token, "access", {
      issuer: this.settings.issuer,
      audience: this.settings.resource,
    });
    if (!payload?.sub || !payload.exp) throw new InvalidTokenError("Invalid or expired access token.");
    return {
      token,
      clientId: payload.cid,
      scopes: payload.scope.split(" "),
      expiresAt: payload.exp,
      resource: new URL(this.settings.resource),
      extra: { userId: payload.sub },
    };
  }

  private async issueTokens(clientId: string, userId: string, scopes: string[]): Promise<OAuthTokens> {
    const claims: GrantClaims = { cid: clientId, scope: scopes.join(" ") };
    const { issuer, resource } = this.settings;
    const [accessToken, refreshToken] = await Promise.all([
      signToken("access", claims, { issuer, subject: userId, audience: resource, ttlSeconds: TTL.access }),
      // A new refresh token every time (rotation). Stateless, so an old one stays valid until it expires.
      signToken("refresh", claims, { issuer, subject: userId, ttlSeconds: TTL.refresh }),
    ]);
    return { access_token: accessToken, token_type: "Bearer", expires_in: TTL.access, refresh_token: refreshToken, scope: claims.scope };
  }

  /** Disabled or deleted users cannot get new tokens. */
  private async assertUserActive(userId: string): Promise<void> {
    try {
      await resolveCallerById(userId);
    } catch (err) {
      if (err instanceof AuthError) throw new InvalidGrantError(err.message);
      throw err;
    }
  }

  /** Codes are single-use. Kept in memory until they expire (5 minutes). */
  private useCodeOnce(jti: string, exp: number): void {
    const now = Date.now() / 1000;
    for (const [id, until] of this.usedCodes) if (until < now) this.usedCodes.delete(id);
    if (this.usedCodes.has(jti)) throw new InvalidGrantError("Authorization code has already been used.");
    this.usedCodes.set(jti, exp);
  }
}
