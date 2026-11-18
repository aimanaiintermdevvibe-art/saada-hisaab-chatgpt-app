import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { AuthError, resolveCallerById, resolveCallerByUsername, type Caller } from "./caller.js";

export type LoginResult = { ok: true; userId: string } | { ok: false; message: string };

/** Checks a Saada Hisaab username and password. The password never reaches ChatGPT. */
export interface LoginVerifier {
  readonly mode: "dev" | "api";
  verify(username: string, password: string): Promise<LoginResult>;
}

const WRONG = "Incorrect username or password.";
const UNKNOWN_USER = "Unknown Saada Hisaab user.";

/** Runs a caller lookup, turning "unknown / disabled user" into a sign-in message. */
async function lookup(find: () => Promise<Caller>, unknownMessage = WRONG): Promise<LoginResult | Caller> {
  try {
    return await find();
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, message: err.message === UNKNOWN_USER ? unknownMessage : err.message };
    throw err;
  }
}
const isCaller = (r: LoginResult | Caller): r is Caller => "tenantId" in r;

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * DEMO ONLY (dummy database): any existing username with one shared password.
 * Used by tests, and before the login API was available.
 */
export class DevPasswordLogin implements LoginVerifier {
  readonly mode = "dev" as const;
  constructor(private readonly password: string) {}

  async verify(username: string, password: string): Promise<LoginResult> {
    if (!timingSafeEqual(digest(password), digest(this.password))) return { ok: false, message: WRONG };
    const found = await lookup(() => resolveCallerByUsername(username));
    return isCaller(found) ? { ok: true, userId: found.userId } : found;
  }
}

interface ApiLoginResponse {
  success?: unknown;
  data?: { user?: { id?: unknown; username?: unknown; tenantId?: unknown } };
}

/**
 * Saada Hisaab's login API (POST { username, password }), called by this server only.
 *   200 { success: true, data: { user: { id, username, tenantId, ... } } } = signed in
 *   400 "Invalid Password." / 404 "Invalid username." = rejected (shown to the user as one generic message)
 * The API also sets an authToken cookie; it is not needed and not kept.
 */
export class SaadaApiLogin implements LoginVerifier {
  readonly mode = "api" as const;
  constructor(
    private readonly url: string,
    private readonly matchBy: "id" | "username" = "id",
  ) {}

  async verify(username: string, password: string): Promise<LoginResult> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
    } catch {
      return { ok: false, message: "Saada Hisaab sign-in is not reachable right now. Please try again." };
    }
    if ([400, 401, 403, 404].includes(response.status)) return { ok: false, message: WRONG };
    if (response.status === 429) return { ok: false, message: "Too many sign-in attempts. Please wait a minute and try again." };

    const body = (await response.json().catch(() => null)) as ApiLoginResponse | null;
    const user = body?.data?.user;
    if (!response.ok || body?.success !== true || typeof user?.id !== "string") {
      return { ok: false, message: "Saada Hisaab sign-in failed. Please try again." };
    }
    return this.matchUser(user.id, typeof user.tenantId === "string" ? user.tenantId : "", user.username);
  }

  /** Finds the API's user in our database: by id with the same tenant, or (demo) by username. */
  private async matchUser(apiUserId: string, apiTenantId: string, apiUsername: unknown): Promise<LoginResult> {
    const notHere = "This Saada Hisaab account is not available in the ChatGPT app yet.";
    if (this.matchBy === "username") {
      if (typeof apiUsername !== "string") return { ok: false, message: notHere };
      const found = await lookup(() => resolveCallerByUsername(apiUsername), notHere);
      return isCaller(found) ? { ok: true, userId: found.userId } : found;
    }
    const found = await lookup(() => resolveCallerById(apiUserId), notHere);
    if (!isCaller(found)) return found;
    // The same person must belong to the same business in both systems, or nothing is shown.
    if (found.tenantId !== apiTenantId) return { ok: false, message: notHere };
    return { ok: true, userId: found.userId };
  }
}

export function createLoginVerifier(): LoginVerifier {
  return config.LOGIN_MODE === "api"
    ? new SaadaApiLogin(config.SAADA_LOGIN_API_URL!, config.LOGIN_MATCH_BY)
    : new DevPasswordLogin(config.DEV_LOGIN_PASSWORD!);
}
