import { pool } from "./pool.js";

/**
 * Database handle given to tools. It can only run queries scoped to one tenant:
 * $1 is always bound to the caller's tenant id, and any SQL that does not use $1 is rejected.
 * Tool code never receives the tenant id from ChatGPT; it comes from the authenticated caller.
 */
export interface TenantDb {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

const USES_TENANT_PARAM = /\$1(?!\d)/;

export function assertTenantScoped(sql: string): void {
  if (!USES_TENANT_PARAM.test(sql)) {
    throw new Error("Tenant guard: query does not filter on $1 (the tenant id).");
  }
}

/** Runs `fn` inside one read-only, repeatable-read transaction (a consistent snapshot for reports). */
export async function withTenant<T>(tenantId: string, fn: (db: TenantDb) => Promise<T>): Promise<T> {
  if (!tenantId) throw new Error("Tenant guard: missing tenant id.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const db: TenantDb = {
      async query<R>(sql: string, params: readonly unknown[] = []) {
        assertTenantScoped(sql);
        const result = await client.query(sql, [tenantId, ...params]);
        return result.rows as R[];
      },
    };
    const value = await fn(db);
    await client.query("COMMIT");
    return value;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Collects extra query parameters. $1 is reserved for the tenant id, so the first
 * value added here becomes $2.
 */
export class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length + 1}`;
  }
}

/** Escapes LIKE wildcards in user text and wraps it for a "contains" match. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
