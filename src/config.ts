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

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PG_HOST: z.string().default("localhost"),
  PG_PORT: z.coerce.number().int().positive().default(5432),
  DB_NAME: z.string().min(1),
  DB_READONLY_USER: z.string().min(1),
  DB_READONLY_PASSWORD: z.string().min(1),
  // disable: local PostgreSQL. require: encrypted (Supabase). verify: encrypted + server certificate checked against PG_SSL_CA_FILE.
  PG_SSL: z.enum(["disable", "require", "verify"]).default("disable"),
  PG_SSL_CA_FILE: z.string().optional(),

  // Render must listen on all interfaces; locally only on this machine.
  HOST: z.string().default(process.env.RENDER ? "0.0.0.0" : "127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
  ALLOWED_HOSTS: z
    .string()
    .default("localhost,127.0.0.1")
    .transform((s) => s.split(",").map((h) => h.trim()).filter(Boolean)),
  // Set by Render to the service's public host name; it is added to ALLOWED_HOSTS automatically.
  RENDER_EXTERNAL_HOSTNAME: z.string().optional(),
  BUSINESS_TIMEZONE: z.string().default("Asia/Karachi").refine(isValidTimeZone, "must be a valid IANA time zone"),
  CURRENCY: z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter ISO code").default("PKR"),

  DEV_USERNAME: z.string().min(1, "set DEV_USERNAME to a Saada Hisaab username"),
  DEV_ACCESS_KEY: z.string().min(24, "DEV_ACCESS_KEY must be at least 24 random characters"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid configuration in .env:\n${problems}`);
}

if (parsed.data.PG_SSL === "verify" && !parsed.data.PG_SSL_CA_FILE) {
  throw new Error("Invalid configuration: PG_SSL=verify needs PG_SSL_CA_FILE (the database's CA certificate).");
}

const renderHost = parsed.data.RENDER_EXTERNAL_HOSTNAME;
export const config = {
  ...parsed.data,
  ALLOWED_HOSTS: renderHost ? [...new Set([...parsed.data.ALLOWED_HOSTS, renderHost])] : parsed.data.ALLOWED_HOSTS,
};

if (config.NODE_ENV === "production") {
  // Dev access acts as one fixed user. It must never serve real customers.
  throw new Error("Dev-user access is enabled. Replace it with OAuth before running with NODE_ENV=production.");
}
