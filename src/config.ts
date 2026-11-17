import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Load <project root>/.env (works from both src/ and dist/). Real environment variables win.
const envFile = fileURLToPath(new URL("../.env", import.meta.url));
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

  PORT: z.coerce.number().int().positive().default(3000),
  ALLOWED_HOSTS: z
    .string()
    .default("localhost,127.0.0.1")
    .transform((s) => s.split(",").map((h) => h.trim()).filter(Boolean)),
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

export const config = parsed.data;

if (config.NODE_ENV === "production") {
  // Dev access acts as one fixed user. It must never serve real customers.
  throw new Error("Dev-user access is enabled. Replace it with OAuth before running with NODE_ENV=production.");
}
