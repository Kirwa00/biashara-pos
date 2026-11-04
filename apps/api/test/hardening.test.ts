import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { app } from "../src/app";
import { withTenant } from "../src/db";
import type { Limiter } from "../src/env";

const base = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://kpos_app:app@localhost:5432/kenya_pos",
  JWT_SECRET: "test-secret-test-secret-test-secret",
  APP_ORIGIN: "http://localhost:5173",
};
const run = Date.now();
const sql = postgres(base.DATABASE_URL, { max: 1 });
const req = (env: object, path: string, init: RequestInit & { token?: string; ip?: string } = {}) =>
  app.request(`http://api.test${path}`, { ...init, headers: { "content-type": "application/json", "cf-connecting-ip": init.ip ?? "203.0.113.9", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } }, env);
const post = (path: string, body: unknown, token = "", env: object = base) => req(env, path, { method: "POST", body: JSON.stringify(body), token });
const json = async <T = Record<string, any>>(r: Response | Promise<Response>) => (await (await r).json()) as T;
/** In-memory stand-in for the Workers Rate Limiting binding. */
const limiter = (limit: number): Limiter & { keys: string[] } => {
  const hits = new Map<string, number>();
  const keys: string[] = [];
  return { keys, async limit({ key }) { keys.push(key); hits.set(key, (hits.get(key) ?? 0) + 1); return { success: hits.get(key)! <= limit }; } };
};

afterAll(() => sql.end());

describe("hardening", () => {
  it("rate-limits sign-in per client IP and rejects oversized bodies", async () => {
    const auth = limiter(3);
    const env = { ...base, AUTH_LIMITER: auth };
    const login = (ip: string) => req(env, "/v1/auth/login", { method: "POST", body: JSON.stringify({ email: `nobody-${run}@x.ke`, password: "wrong" }), ip });
    for (let i = 0; i < 3; i++) expect((await login("198.51.100.1")).status).toBe(401);
    const blocked = await login("198.51.100.1");
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: string }).error).toMatch(/Too many requests/);
    expect((await login("198.51.100.2")).status).toBe(401);
    expect(auth.keys[0]).toBe("auth:198.51.100.1");
    expect((await req(env, "/health")).status).toBe(200);

    const big = await req(base, "/v1/auth/login", { method: "POST", body: JSON.stringify({ email: "a@b.ke", password: "x".repeat(3 * 1024 * 1024) }) });
    expect(big.status).toBe(413);
  });

  it("switching a user off ends their sessions; owners and self are protected", async () => {
    const reg = await json(post("/v1/auth/register", { businessName: "harden", ownerName: "Owner", email: `harden-${run}@h.ke`, phone: "0712345678", password: "correct-horse-1" }));
    const t = reg.accessToken as string;
    const email = `cashier-${run}@h.ke`;
    const cashier = await json(post("/v1/users", { name: "Cashier", email, password: "correct-horse-1", role: "CASHIER" }, t));
    const session = await json(post("/v1/auth/login", { email, password: "correct-horse-1" }));
    const me = await json(req(base, "/v1/me", { token: t }));

    expect((await req(base, `/v1/users/${cashier.id}`, { method: "PATCH", body: JSON.stringify({}), token: t })).status).toBe(400);
    expect((await req(base, `/v1/users/${me.user.id}`, { method: "PATCH", body: JSON.stringify({ isActive: false }), token: t })).status).toBe(409);
    expect((await req(base, `/v1/users/${cashier.id}`, { method: "PATCH", body: JSON.stringify({ isActive: false }), token: session.accessToken })).status).toBe(403);
    expect(await json(req(base, `/v1/users/${cashier.id}`, { method: "PATCH", body: JSON.stringify({ role: "MANAGER", isActive: false }), token: t }))).toMatchObject({ role: "MANAGER", is_active: false });

    expect((await post("/v1/auth/refresh", { refreshToken: session.refreshToken })).status).toBe(401);
    expect((await post("/v1/auth/login", { email, password: "correct-horse-1" })).status).toBe(401);
    const audit = await json<{ action: string }[]>(req(base, "/v1/audit", { token: t }));
    expect(audit.some((a) => a.action === "user.update")).toBe(true);

    const other = await json(post("/v1/auth/register", { businessName: "harden-b", ownerName: "Owner", email: `harden-b-${run}@h.ke`, phone: "0712345678", password: "correct-horse-1" }));
    expect((await req(base, `/v1/users/${cashier.id}`, { method: "PATCH", body: JSON.stringify({ isActive: true }), token: other.accessToken })).status).toBe(404);
  });

  it("books check passes on real activity and catches a corrupted ledger", async () => {
    const reg = await json(post("/v1/auth/register", { businessName: "books", ownerName: "Owner", email: `books-${run}@h.ke`, phone: "0712345678", password: "correct-horse-1" }));
    const t = reg.accessToken as string;
    const bid = (await json(req(base, "/v1/me", { token: t }))).business.id as string;
    const p = await json(post("/v1/products", { sku: "OIL", name: "Oil 1L", retailPriceCents: 35000 }, t));
    await post("/v1/stock/opening", { lines: [{ productId: p.id, quantity: 10, unitCostCents: 28000 }] }, t);
    expect((await post("/v1/shifts/open", { openingFloatCents: 0 }, t)).status).toBe(201);
    const sale = await json(post("/v1/documents", { type: "SALE", lines: [{ productId: p.id, quantity: 2 }], payments: [{ method: "CASH", amountCents: 70000 }] }, t));
    await post(`/v1/documents/${sale.id}/return`, { lines: [{ productId: p.id, quantity: 1 }], reason: "Leaking" }, t);
    const cust = await json(post("/v1/customers", { name: "Duka", creditLimitCents: 1_000_000 }, t));
    const inv = await json(post("/v1/documents", { type: "INVOICE", customerId: cust.id, lines: [{ productId: p.id, quantity: 1 }] }, t));
    await post(`/v1/documents/${inv.id}/payments`, { method: "CASH", amountCents: 10000 }, t);

    expect(await json(req(base, "/v1/reports/integrity", { token: t }))).toMatchObject({ ok: true, failed: [] });

    await withTenant(sql, bid, (tx) => tx`UPDATE stock_balances SET on_hand = on_hand + 1 WHERE product_id = ${p.id}`);
    const broken = await json(req(base, "/v1/reports/integrity", { token: t }));
    expect(broken).toMatchObject({ ok: false, failed: ["stock_balance"] });
    expect(broken.checks.stock_balance[0]).toMatchObject({ product_id: p.id });
    await withTenant(sql, bid, (tx) => tx`UPDATE businesses SET status = 'SUSPENDED' WHERE id = ${bid}`);
  });
});
