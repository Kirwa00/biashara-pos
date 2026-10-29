import { describe, expect, it } from "vitest";
import { app } from "../src/app";

const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://kpos_app:app@localhost:5432/kenya_pos",
  JWT_SECRET: "test-secret-test-secret-test-secret",
  APP_ORIGIN: "http://localhost:5173",
};
const run = Date.now();
const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  app.request(path, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } }, env);
const post = (path: string, body: unknown, token: string) => call(path, { method: "POST", body: JSON.stringify(body), token });
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const register = async (name: string) =>
  (await json<{ accessToken: string }>(post("/v1/auth/register", { businessName: name, ownerName: "Owner", email: `${name}-${run}@stock.ke`, phone: "0712345678", password: "correct-horse-1" }, ""))).accessToken;
const staff = async (owner: string, role: string) => {
  const email = `${role.toLowerCase()}-${Math.random().toString(36).slice(2)}-${run}@stock.ke`;
  await post("/v1/users", { name: role, email, role, password: "staff-pass-123" }, owner);
  return (await json<{ accessToken: string }>(post("/v1/auth/login", { email, password: "staff-pass-123" }, ""))).accessToken;
};
type Row = { product_id: string; on_hand: string; avg_cost_cents: string; low_stock: boolean };

describe("stock ledger", () => {
  it("posts opening, approved adjustments and counts; ledger sums equal on-hand", async () => {
    const owner = await register("stock-a");
    const other = await register("stock-b");
    const manager = await staff(owner, "MANAGER");
    const manager2 = await staff(owner, "MANAGER");
    const cashier = await staff(owner, "CASHIER");
    const product = await json<{ id: string }>(post("/v1/products", { sku: "MILK", name: "Milk 500ml", retailPriceCents: 6000, reorderLevel: 5 }, owner));
    const pid = product.id;

    expect((await post("/v1/stock/opening", { lines: [{ productId: pid, quantity: 10, unitCostCents: 5000 }] }, owner)).status).toBe(201);
    expect((await post("/v1/stock/opening", { lines: [{ productId: pid, quantity: 1, unitCostCents: 1 }] }, owner)).status).toBe(409);

    expect((await post("/v1/stock/adjustments", { productId: pid, quantity: -1, reason: "Damaged" }, cashier)).status).toBe(403);
    const adj = await json<{ id: string; status: string }>(post("/v1/stock/adjustments", { productId: pid, quantity: -3, reason: "Damaged" }, manager));
    expect(adj.status).toBe("PENDING");
    expect((await post(`/v1/stock/adjustments/${adj.id}/approve`, {}, manager)).status).toBe(403);
    expect((await post(`/v1/stock/adjustments/${adj.id}/approve`, {}, manager2)).status).toBe(200);
    expect((await post(`/v1/stock/adjustments/${adj.id}/approve`, {}, owner)).status).toBe(409);

    const big = await json<{ id: string }>(post("/v1/stock/adjustments", { productId: pid, quantity: -100, reason: "Typo test" }, manager));
    expect((await post(`/v1/stock/adjustments/${big.id}/approve`, {}, owner)).status).toBe(409);
    expect((await post(`/v1/stock/adjustments/${big.id}/reject`, {}, owner)).status).toBe(200);

    const count = await json<{ lines: { expected: string; variance: string }[] }>(post("/v1/stock/counts", { note: "Month end", lines: [{ productId: pid, counted: 4 }] }, owner));
    expect(count.lines[0]).toMatchObject({ expected: "7.000", variance: "-3.000" });

    const [row] = await json<Row[]>(call("/v1/stock", { token: manager }));
    expect(row).toMatchObject({ product_id: pid, on_hand: "4.000", avg_cost_cents: "5000", low_stock: true });
    expect(await json<Row[]>(call("/v1/stock?low=1", { token: owner }))).toHaveLength(1);

    const moves = await json<{ type: string; quantity: string }[]>(call(`/v1/stock/movements?productId=${pid}`, { token: owner }));
    expect(moves.map((m) => m.type)).toEqual(["COUNT", "ADJUSTMENT", "OPENING"]);
    expect(moves.reduce((s, m) => s + Number(m.quantity), 0)).toBe(4);

    expect(await json<Row[]>(call("/v1/stock", { token: other }))).toEqual([]);
    expect((await post("/v1/stock/adjustments", { productId: pid, quantity: 5, reason: "Cross tenant" }, other)).status).toBe(400);
  });
});
