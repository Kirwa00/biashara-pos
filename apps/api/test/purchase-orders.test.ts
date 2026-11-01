import { describe, expect, it } from "vitest";
import { app } from "../src/app";

const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://kpos_app:app@localhost:5432/kenya_pos",
  JWT_SECRET: "test-secret-test-secret-test-secret",
  APP_ORIGIN: "http://localhost:5173",
  ENCRYPTION_KEY: "test-encryption-key",
};
const run = Date.now();
const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  app.request(`http://api.test${path}`, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } }, env);
const post = (path: string, body: unknown, token: string) => call(path, { method: "POST", body: JSON.stringify(body), token });
const json = async <T = Record<string, unknown>>(r: Response | Promise<Response>) => (await (await r).json()) as T;

describe("purchase orders", () => {
  it("raises, approves, receives in part then full, and refuses over-delivery", async () => {
    const t = (await json<{ accessToken: string }>(post("/v1/auth/register", { businessName: "po", ownerName: "Owner", email: `po-${run}@p.ke`, phone: "0712345678", password: "correct-horse-1" }, ""))).accessToken;
    const p = await json<{ id: string }>(post("/v1/products", { sku: "RICE", name: "Rice 2kg", retailPriceCents: 40000 }, t));
    const sup = await json<{ id: string }>(post("/v1/suppliers", { name: "Pishori Ltd" }, t));

    expect((await post("/v1/purchase-orders", { supplierId: sup.id, lines: [{ productId: p.id, quantity: 1, unitCostCents: 1 }, { productId: p.id, quantity: 1, unitCostCents: 1 }] }, t)).status).toBe(400);
    const po = await json<{ id: string; status: string; total_cents: string }>(post("/v1/purchase-orders", { supplierId: sup.id, lines: [{ productId: p.id, quantity: 10, unitCostCents: 5000 }] }, t));
    expect(po).toMatchObject({ status: "PENDING", total_cents: "50000" });

    expect((await post(`/v1/purchase-orders/${po.id}/receive`, { lines: [{ productId: p.id, quantity: 4 }] }, t)).status).toBe(409);
    expect((await post(`/v1/purchase-orders/${po.id}/approve`, {}, t)).status).toBe(200);
    expect((await post(`/v1/purchase-orders/${po.id}/approve`, {}, t)).status).toBe(409);

    expect(await json(post(`/v1/purchase-orders/${po.id}/receive`, { lines: [{ productId: p.id, quantity: 4 }] }, t))).toMatchObject({ status: "PARTIAL" });
    const list = await json<{ id: string; outstanding_cents: string }[]>(call("/v1/purchase-orders", { token: t }));
    expect(list.find((x) => x.id === po.id)?.outstanding_cents).toBe("30000");
    expect((await post(`/v1/purchase-orders/${po.id}/receive`, { lines: [{ productId: p.id, quantity: 7 }] }, t)).status).toBe(409);
    expect(await json(post(`/v1/purchase-orders/${po.id}/receive`, { lines: [{ productId: p.id, quantity: 6 }] }, t))).toMatchObject({ status: "RECEIVED" });
    expect((await post(`/v1/purchase-orders/${po.id}/cancel`, {}, t)).status).toBe(409);

    const detail = await json<{ lines: { quantity_received: string }[] }>(call(`/v1/purchase-orders/${po.id}`, { token: t }));
    expect(detail.lines[0]!.quantity_received).toBe("10.000");
    const sups = await json<{ id: string; balance_cents: string }[]>(call("/v1/suppliers", { token: t }));
    expect(sups.find((s) => s.id === sup.id)?.balance_cents).toBe("50000");

    const po2 = await json<{ id: string }>(post("/v1/purchase-orders", { supplierId: sup.id, lines: [{ productId: p.id, quantity: 3, unitCostCents: 5000 }] }, t));
    expect((await post(`/v1/purchase-orders/${po2.id}/cancel`, {}, t)).status).toBe(200);
    expect((await post(`/v1/purchase-orders/${po2.id}/receive`, { lines: [{ productId: p.id, quantity: 1 }] }, t)).status).toBe(409);
    expect((await call("/v1/purchase-orders/not-a-uuid", { token: t })).status).toBe(404);
  });
});
