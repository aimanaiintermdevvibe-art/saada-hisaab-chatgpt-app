import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveCallerByUsername, type Caller } from "../src/auth/caller.js";
import { SaadaApiLogin } from "../src/auth/login.js";
import { pool } from "../src/db/pool.js";
import { USER_A } from "./helpers.js";

// SaadaApiLogin against a fake Saada Hisaab login API that answers like the real one
// (https://demoapi.sadahisab.com/api/auth/login), so the suite never calls the real API.

let url = "";
let server: http.Server;
let next: { status: number; body: unknown } = { status: 200, body: {} };
let lastRequest: { contentType?: string; body?: unknown } = {};
let admin: Caller;

const ok = (user: Record<string, unknown>) => ({
  status: 200,
  body: { success: true, message: "User logged in successfully", data: { user } },
});

beforeAll(async () => {
  admin = await resolveCallerByUsername(USER_A);
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c)).on("end", () => {
      lastRequest = { contentType: req.headers["content-type"], body: JSON.parse(raw || "{}") };
      res.writeHead(next.status, { "Content-Type": "application/json" }).end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/login`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

describe("Saada Hisaab login API", () => {
  it("sends { username, password } as JSON", async () => {
    next = ok({ id: admin.userId, username: admin.username, tenantId: admin.tenantId });
    await new SaadaApiLogin(url).verify("admin", "secret-1");
    expect(lastRequest.contentType).toContain("application/json");
    expect(lastRequest.body).toEqual({ username: "admin", password: "secret-1" });
  });

  it("signs in when the API's user id and tenant match our database", async () => {
    next = ok({ id: admin.userId, username: admin.username, tenantId: admin.tenantId });
    expect(await new SaadaApiLogin(url).verify("admin", "x")).toEqual({ ok: true, userId: admin.userId });
  });

  it("refuses when the API's tenant differs from ours (never shows another business)", async () => {
    next = ok({ id: admin.userId, username: admin.username, tenantId: "some-other-tenant" });
    expect((await new SaadaApiLogin(url).verify("admin", "x")).ok).toBe(false);
  });

  it("by id: refuses a user our database does not have", async () => {
    next = ok({ id: "not-in-our-database", username: admin.username, tenantId: "t" });
    const r = await new SaadaApiLogin(url, "id").verify("admin", "x");
    expect(r).toEqual({ ok: false, message: "This Saada Hisaab account is not available in the ChatGPT app yet." });
  });

  it("by username (demo): finds the user by the API's username", async () => {
    next = ok({ id: "not-in-our-database", username: admin.username, tenantId: "t" });
    expect(await new SaadaApiLogin(url, "username").verify("admin", "x")).toEqual({ ok: true, userId: admin.userId });
  });

  it.each([
    [400, { success: false, message: "Invalid Password." }],
    [404, { success: false, message: "Invalid username." }],
  ])("HTTP %i: one generic message (does not reveal which part was wrong)", async (status, body) => {
    next = { status, body };
    expect(await new SaadaApiLogin(url).verify("admin", "x")).toEqual({ ok: false, message: "Incorrect username or password." });
  });

  it("server errors and odd answers fail safely", async () => {
    next = { status: 500, body: { success: false } };
    expect((await new SaadaApiLogin(url).verify("admin", "x")).ok).toBe(false);
    next = { status: 200, body: { success: false } };
    expect((await new SaadaApiLogin(url).verify("admin", "x")).ok).toBe(false);
    next = { status: 200, body: { success: true, data: {} } };
    expect((await new SaadaApiLogin(url).verify("admin", "x")).ok).toBe(false);
  });

  it("an unreachable API gives a clear message", async () => {
    const r = await new SaadaApiLogin("http://127.0.0.1:9/api/auth/login").verify("admin", "x");
    expect(r).toEqual({ ok: false, message: "Saada Hisaab sign-in is not reachable right now. Please try again." });
  });
});
