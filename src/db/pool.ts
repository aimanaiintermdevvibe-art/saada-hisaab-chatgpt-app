import pg from "pg";
import { config } from "../config.js";

const OID = { INT8: 20, NUMERIC: 1700, DATE: 1082, TIMESTAMP: 1114 } as const;

/**
 * Value parsing for this pool only (the global pg defaults are left alone):
 * - numeric/bigint -> number. Sums are computed in SQL as exact numerics; amounts stay far below 2^53.
 * - date -> 'YYYY-MM-DD' string, so it is not shifted by the server's time zone.
 * - timestamp (stored as UTC by Prisma) -> ISO string with 'Z'.
 */
const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (format !== "binary") {
      if (oid === OID.NUMERIC || oid === OID.INT8) return (v: string) => Number(v);
      if (oid === OID.DATE) return (v: string) => v;
      if (oid === OID.TIMESTAMP) return (v: string) => `${v.replace(" ", "T")}Z`;
    }
    return pg.types.getTypeParser(oid, format);
  },
} as pg.CustomTypesConfig;

/** Pool for the read-only login. The role itself forces read-only transactions and a statement timeout. */
export const pool = new pg.Pool({
  host: config.PG_HOST,
  port: config.PG_PORT,
  database: config.DB_NAME,
  user: config.DB_READONLY_USER,
  password: config.DB_READONLY_PASSWORD,
  application_name: "saada-hisaab-mcp",
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000,
  types,
});

pool.on("error", (err) => {
  console.error(JSON.stringify({ level: "error", msg: "idle database client error", error: err.message }));
});
