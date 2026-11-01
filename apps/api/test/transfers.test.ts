import { describe, expect, it } from "vitest";
import { app } from "../src/app";

const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://kpos_app:app@localhost:5432/kenya_pos",
  JWT_SECRET: "test-secret-test-secret-test-secret",
  APP_ORIGIN: "http://localhost:5173",
};
const run = Date.now();
const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  app.request(`http://api.test${path}`, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } }, env);
const post = (path: string, body: unknown, token: string) => call(path, { method: "POST", body: JSON.stringify(body), token });
const json = async <T = Record<string, any>>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const register = async (name: string) =>
  (await json(post("/v1/auth/register", { businessName: name, ownerName: "Owner", email: `${name}-${run}@tr.ke`, phone: "0712345678", password: "correct-horse-1" }, ""))).accessToken as string;

describe("branch stock transfers", () => {
  it("moves stock only when sent and received, at the source's cost, recording shortfalls", async () => {
    const t = await register("transfers");
    const west = await json(post("/v1/branches", { name: "Westlands", code: "WEST" }, t));
    const main = (await json<{ id: string; code: string }[]>(call("/v1/branches", { token: t }))).find((b) => b.code === "MAIN")!;
    const rice = await json(post("/v1/products", { sku: "RICE", name: "Rice 2kg", retailPriceCents: 40000 }, t));
    const svc = await json(post("/v1/products", { sku: "SVC", name: "Delivery", retailPriceCents: 20000, trackStock: false }, t));
    await post("/v1/stock/opening", { lines: [{ productId: rice.id, quantity: 10, unitCostCents: 25000 }] }, t);
    const onHand = async (branchId: string) =>
      (await json<{ product_id: string; on_hand: string; avg_cost_cents: string }[]>(call(`/v1/stock?branchId=${branchId}`, { token: t }))).find((r) => r.product_id === rice.id)!;

    expect((await post("/v1/transfers", { fromBranchId: main.id, toBranchId: main.id, lines: [{ productId: rice.id, quantity: 1 }] }, t)).status).toBe(400);
    expect((await post("/v1/transfers", { fromBranchId: main.id, toBranchId: west.id, lines: [{ productId: svc.id, quantity: 1 }] }, t)).status).toBe(400);
    const tr = await json(post("/v1/transfers", { fromBranchId: main.id, toBranchId: west.id, note: "Weekend stock", lines: [{ productId: rice.id, quantity: 4 }] }, t));
    expect(tr).toMatchObject({ status: "PENDING", number: 1 });
    expect((await onHand(main.id)).on_hand).toBe("10.000");
    expect((await post(`/v1/transfers/${tr.id}/receive`, {}, t)).status).toBe(409);

    expect(await json(post(`/v1/transfers/${tr.id}/send`, {}, t))).toMatchObject({ status: "IN_TRANSIT" });
    expect((await onHand(main.id)).on_hand).toBe("6.000");
    expect((await onHand(west.id)).on_hand).toBe("0");
    expect((await post(`/v1/transfers/${tr.id}/send`, {}, t)).status).toBe(409);
    expect((await post(`/v1/transfers/${tr.id}/cancel`, {}, t)).status).toBe(409);

    // One bag lost on the road.
    expect((await post(`/v1/transfers/${tr.id}/receive`, { lines: [{ productId: rice.id, quantity: 5 }] }, t)).status).toBe(409);
    expect((await post(`/v1/transfers/${tr.id}/receive`, { lines: [{ productId: svc.id, quantity: 1 }] }, t)).status).toBe(422);
    expect(await json(post(`/v1/transfers/${tr.id}/receive`, { lines: [{ productId: rice.id, quantity: 3 }] }, t))).toMatchObject({ status: "RECEIVED" });
    expect(await onHand(west.id)).toMatchObject({ on_hand: "3.000", avg_cost_cents: "25000" });
    expect((await post(`/v1/transfers/${tr.id}/receive`, {}, t)).status).toBe(409);

    const detail = await json(call(`/v1/transfers/${tr.id}`, { token: t }));
    expect(detail.lines[0]).toMatchObject({ quantity: "4.000", quantity_received: "3.000", unit_cost_cents: "25000" });
    const list = await json<{ id: string; short: boolean; value_cents: string; from_branch: string; to_branch: string }[]>(call("/v1/transfers", { token: t }));
    expect(list.find((x) => x.id === tr.id)).toMatchObject({ short: true, value_cents: "100000", from_branch: "Main Branch", to_branch: "Westlands" });

    // Can't send more than is on hand; an unsent transfer can be cancelled.
    const big = await json(post("/v1/transfers", { fromBranchId: main.id, toBranchId: west.id, lines: [{ productId: rice.id, quantity: 20 }] }, t));
    expect((await post(`/v1/transfers/${big.id}/send`, {}, t)).status).toBe(409);
    expect((await onHand(main.id)).on_hand).toBe("6.000");
    expect(await json(post(`/v1/transfers/${big.id}/cancel`, {}, t))).toMatchObject({ status: "CANCELLED" });

    // A full receipt needs no lines.
    const back = await json(post("/v1/transfers", { fromBranchId: west.id, toBranchId: main.id, lines: [{ productId: rice.id, quantity: 1 }] }, t));
    await post(`/v1/transfers/${back.id}/send`, {}, t);
    expect(await json(post(`/v1/transfers/${back.id}/receive`, {}, t))).toMatchObject({ status: "RECEIVED" });
    expect((await onHand(main.id)).on_hand).toBe("7.000");
    expect((await onHand(west.id)).on_hand).toBe("2.000");

    expect(await json(call("/v1/reports/integrity", { token: t }))).toMatchObject({ ok: true });

    await post("/v1/users", { name: "Cashier", email: `cashier-${run}@tr.ke`, password: "correct-horse-1", role: "CASHIER" }, t);
    const ct = (await json(post("/v1/auth/login", { email: `cashier-${run}@tr.ke`, password: "correct-horse-1" }, ""))).accessToken as string;
    expect((await post("/v1/transfers", { fromBranchId: main.id, toBranchId: west.id, lines: [{ productId: rice.id, quantity: 1 }] }, ct)).status).toBe(403);

    const other = await register("transfers-b");
    expect((await call(`/v1/transfers/${tr.id}`, { token: other })).status).toBe(404);
    expect((await post(`/v1/transfers/${back.id}/cancel`, {}, other)).status).toBe(404);
    expect(await json(call("/v1/transfers", { token: other }))).toEqual([]);
  });
});
