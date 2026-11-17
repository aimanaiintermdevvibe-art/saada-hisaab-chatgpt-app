import { pool } from "../db/pool.js";

/** The signed-in Saada Hisaab user a request acts as. All tool queries are scoped to `tenantId`. */
export interface Caller {
  userId: string;
  username: string;
  fullName: string;
  role: "ADMIN" | "MANAGER" | "CASHIER";
  tenantId: string;
  businessName: string;
  branchId: string | null;
}

export class AuthError extends Error {}

interface UserRow {
  id: string;
  username: string;
  fullName: string;
  role: string;
  tenantId: string;
  branchId: string | null;
  isEnabled: boolean;
  isDeleted: boolean;
  businessName: string;
  tenantEnabled: boolean;
}

/** Looks up a user by login name (sign-in, and the dev shortcut). */
export const resolveCallerByUsername = (username: string) => loadCaller("username", username);

/** Looks up a user by id (the `sub` of an OAuth access token). */
export const resolveCallerById = (userId: string) => loadCaller("id", userId);

/**
 * Looks up a user and their tenant, and checks the account may be used. This identity lookup is
 * the only query that is not tenant-scoped, because it is how the tenant is found.
 */
async function loadCaller(by: "username" | "id", value: string): Promise<Caller> {
  const column = by === "id" ? "u.id" : "u.username"; // one of two fixed strings
  const { rows } = await pool.query<UserRow>(
    `SELECT u.id, u.username, u."fullName", u.role::text AS role, u."tenantId", u."branchId",
            u."isEnabled", u."isDeleted", t."businessName", t."isEnabled" AS "tenantEnabled"
       FROM "User" u
       JOIN "Tenant" t ON t.id = u."tenantId"
      WHERE ${column} = $1`,
    [value],
  );
  const u = rows[0];
  if (!u || u.isDeleted) throw new AuthError("Unknown Saada Hisaab user.");
  if (!u.isEnabled || !u.tenantEnabled) throw new AuthError("This Saada Hisaab account is disabled.");
  if (u.role !== "ADMIN" && u.role !== "MANAGER" && u.role !== "CASHIER") {
    throw new AuthError("This account type cannot use the ChatGPT app.");
  }
  return {
    userId: u.id,
    username: u.username,
    fullName: u.fullName,
    role: u.role,
    tenantId: u.tenantId,
    businessName: u.businessName,
    branchId: u.branchId,
  };
}
