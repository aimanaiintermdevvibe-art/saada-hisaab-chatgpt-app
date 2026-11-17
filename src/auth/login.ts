import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { AuthError, resolveCallerByUsername } from "./caller.js";

export type LoginResult = { ok: true; userId: string } | { ok: false; message: string };

/** Checks a Saada Hisaab username and password. The password never reaches ChatGPT. */
export interface LoginVerifier {
  readonly mode: "dev" | "api";
  verify(username: string, password: string): Promise<LoginResult>;
}

const WRONG = "Incorrect username or password.";

/** After the password is accepted: the user must exist in the database and be allowed to sign in. */
async function userIdFor(username: string): Promise<LoginResult> {
  try {
    const caller = await resolveCallerByUsername(username);
    return { ok: true, userId: caller.userId };
  } catch (err) {
    if (err instanceof AuthError) {
      return { ok: false, message: err.message === "Unknown Saada Hisaab user." ? WRONG : err.message };
    }
    throw err;
  }
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * DEMO ONLY (dummy database): any existing username with the shared DEV_LOGIN_PASSWORD.
 * Lets us test sign-in and per-business data in ChatGPT before the login API is connected.
 */
class DevPasswordLogin implements LoginVerifier {
  readonly mode = "dev" as const;
  constructor(private readonly password: string) {}

  async verify(username: string, password: string): Promise<LoginResult> {
    if (!timingSafeEqual(digest(password), digest(this.password))) return { ok: false, message: WRONG };
    return userIdFor(username);
  }
}

/**
 * Saada Hisaab's login API, called by this server only (never exposed to ChatGPT).
 *
 * TODO(DevVibe API details): request and response format are assumed until DevVibe shares the
 * spec: POST JSON { username, password }; any 2xx = valid credentials; 400/401/403 = rejected.
 * The tenant is then taken from our database by username, never from the API response.
 */
class SaadaApiLogin implements LoginVerifier {
  readonly mode = "api" as const;
  constructor(private readonly url: string) {}

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
    if ([400, 401, 403].includes(response.status)) return { ok: false, message: WRONG };
    if (!response.ok) return { ok: false, message: "Saada Hisaab sign-in failed. Please try again." };
    return userIdFor(username);
  }
}

export function createLoginVerifier(): LoginVerifier {
  return config.LOGIN_MODE === "api"
    ? new SaadaApiLogin(config.SAADA_LOGIN_API_URL!)
    : new DevPasswordLogin(config.DEV_LOGIN_PASSWORD!);
}
