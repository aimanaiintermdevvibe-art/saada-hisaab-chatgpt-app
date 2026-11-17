import { createHmac, randomUUID } from "node:crypto";
import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import { config } from "../config.js";

/**
 * Everything OAuth hands out is a signed token (HS256 with OAUTH_SECRET), so nothing has to be
 * stored: the server can restart or sleep (Render free plan) without breaking ChatGPT's connection.
 * The `typ` claim keeps the kinds apart, e.g. a refresh token is never accepted as an access token.
 */
export type TokenType = "client" | "authreq" | "code" | "access" | "refresh";

const key = new TextEncoder().encode(config.OAUTH_SECRET);

export interface SignOptions {
  issuer: string;
  subject?: string;
  audience?: string;
  ttlSeconds?: number;
}

export async function signToken(typ: TokenType, claims: Record<string, unknown>, opts: SignOptions): Promise<string> {
  let jwt = new SignJWT({ ...claims, typ })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(opts.issuer)
    .setIssuedAt()
    .setJti(randomUUID());
  if (opts.subject) jwt = jwt.setSubject(opts.subject);
  if (opts.audience) jwt = jwt.setAudience(opts.audience);
  if (opts.ttlSeconds) jwt = jwt.setExpirationTime(Math.floor(Date.now() / 1000) + opts.ttlSeconds);
  return jwt.sign(key);
}

/** Checks signature, issuer, expiry, type and (if given) audience. Returns null when anything is off. */
export async function verifyToken<T extends object>(
  token: string,
  typ: TokenType,
  opts: { issuer: string; audience?: string },
): Promise<(JWTPayload & T) | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      issuer: opts.issuer,
      ...(opts.audience ? { audience: opts.audience } : {}),
    });
    return payload.typ === typ ? (payload as JWTPayload & T) : null;
  } catch {
    return null;
  }
}

/** A registered client's secret, recomputed from its id, so it never needs storing. */
export function clientSecretFor(clientId: string): string {
  return createHmac("sha256", config.OAUTH_SECRET).update(`client-secret:${clientId}`).digest("base64url");
}
