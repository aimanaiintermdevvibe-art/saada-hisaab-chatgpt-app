import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Load <project root>/.env, or the file named by ENV_FILE (e.g. .env.supabase). Works from src/ and dist/.
// Real environment variables always win, so a host like Render needs no file at all.
const envFile = fileURLToPath(new URL(`../${process.env.ENV_FILE ?? ".env"}`, import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

function isValidTimeZone(tz: string): boolean {
  // The value is inlined into SQL, so allow only IANA-style names.
  if (!/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s) => s.split(",").map((h) => h.trim()).filter(Boolean));

/** An optional setting where an empty value (`KEY=`) means "not set". */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const schema = z
  .object({
    NODE_ENV: z.string().default("development"),

    // ---------- Database ----------
    PG_HOST: z.string().default("localhost"),
    PG_PORT: z.coerce.number().int().positive().default(5432),
    DB_NAME: z.string().min(1),
    DB_READONLY_USER: z.string().min(1),
    DB_READONLY_PASSWORD: z.string().min(1),
    // disable: local PostgreSQL. require: encrypted (Supabase). verify: encrypted + certificate checked against PG_SSL_CA_FILE.
    PG_SSL: z.enum(["disable", "require", "verify"]).default("disable"),
    PG_SSL_CA_FILE: optional(z.string()),

    // ---------- HTTP ----------
    // Render must listen on all interfaces; locally only on this machine.
    HOST: z.string().default(process.env.RENDER ? "0.0.0.0" : "127.0.0.1"),
    PORT: z.coerce.number().int().positive().default(3000),
    ALLOWED_HOSTS: csv("localhost,127.0.0.1"),
    // Number of proxies in front of the app (Render: 1), so rate limits see the real client IP.
    TRUST_PROXY: z.coerce.number().int().min(0).default(process.env.RENDER ? 1 : 0),
    // Public address of this server, used as the OAuth issuer. Defaults to Render's URL, else localhost.
    PUBLIC_BASE_URL: optional(z.url()),
    RENDER_EXTERNAL_URL: optional(z.url()),
    RENDER_EXTERNAL_HOSTNAME: optional(z.string()),

    // ---------- Business ----------
    BUSINESS_TIMEZONE: z.string().default("Asia/Karachi").refine(isValidTimeZone, "must be a valid IANA time zone"),
    CURRENCY: z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter ISO code").default("PKR"),

    // ---------- OAuth (how ChatGPT users sign in) ----------
    // Signs client IDs, authorization codes and tokens. Changing it signs everyone out.
    OAUTH_SECRET: z.string().min(32, "OAUTH_SECRET must be at least 32 random characters"),
    // Hosts allowed as OAuth redirect targets when clients register.
    OAUTH_REDIRECT_HOSTS: csv("chatgpt.com,chat.openai.com,claude.ai,localhost,127.0.0.1"),
    // dev: any Saada Hisaab username + DEV_LOGIN_PASSWORD (dummy data only). api: Saada Hisaab login API.
    LOGIN_MODE: z.enum(["dev", "api"]).default("dev"),
    DEV_LOGIN_PASSWORD: optional(z.string()),
    SAADA_LOGIN_API_URL: optional(z.url()),
    // How an API-verified user is found in our database. id (production): the API's user id, with the same
    // tenant. username: only when the login API and this database are different copies (the demo).
    LOGIN_MATCH_BY: z.enum(["id", "username"]).default("id"),

    // ---------- Dev shortcut without OAuth (optional) ----------
    // When both are set, /mcp/<DEV_ACCESS_KEY> acts as DEV_USERNAME. Leave empty to disable.
    DEV_USERNAME: optional(z.string().min(1)),
    DEV_ACCESS_KEY: optional(z.string().min(24, "DEV_ACCESS_KEY must be at least 24 random characters")),
  })
  .superRefine((c, ctx) => {
    const fail = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (c.PG_SSL === "verify" && !c.PG_SSL_CA_FILE) fail("PG_SSL_CA_FILE", "required when PG_SSL=verify");
    if (c.LOGIN_MODE === "dev" && (c.DEV_LOGIN_PASSWORD ?? "").length < 8) {
      fail("DEV_LOGIN_PASSWORD", "required (at least 8 characters) when LOGIN_MODE=dev");
    }
    if (c.LOGIN_MODE === "api" && !c.SAADA_LOGIN_API_URL) fail("SAADA_LOGIN_API_URL", "required when LOGIN_MODE=api");
    if (c.DEV_ACCESS_KEY && !c.DEV_USERNAME) fail("DEV_USERNAME", "required when DEV_ACCESS_KEY is set");
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid configuration:\n${problems}`);
}

const c = parsed.data;
const publicBaseUrl = (c.PUBLIC_BASE_URL ?? c.RENDER_EXTERNAL_URL ?? `http://localhost:${c.PORT}`).replace(/\/+$/, "");
const extraHosts = [new URL(publicBaseUrl).hostname, ...(c.RENDER_EXTERNAL_HOSTNAME ? [c.RENDER_EXTERNAL_HOSTNAME] : [])];

export const config = {
  ...c,
  /** e.g. https://saada-hisaab-mcp.onrender.com (no trailing slash). */
  PUBLIC_BASE_URL: publicBaseUrl,
  ALLOWED_HOSTS: [...new Set([...c.ALLOWED_HOSTS, ...extraHosts])],
};
