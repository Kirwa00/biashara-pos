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
const register = async (name: string) => {
  const res = await call("/v1/auth/register", { method: "POST", body: JSON.stringify({ businessName: name, ownerName: "Owner", email: `${name}-${run}@val.ke`, phone: "0712345678", password: "correct-horse-1" }) });
  return ((await res.json()) as { accessToken: string }).accessToken;
};
type Val = { total_cents: string; products: { on_hand: string; avg_cost_cents: string; value_cents: string }[] };
const valuation = async (t: string, q = "") => (await (await call(`/v1/reports/stock-valuation${q}`, { token: t })).json()) as Val;

describe("stock valuation", () => {
  it("values stock at weighted average cost, now and as at a past date", async () => {
    const t = await register("valuation");
    const p = (await (await post("/v1/products", { sku: "OIL", name: "Oil 1L", retailPriceCents: 40000 }, t)).json()) as { id: string };
    const s = (await (await post("/v1/suppliers", { name: "Bidco" }, t)).json()) as { id: string };
    expect((await post("/v1/stock/opening", { lines: [{ productId: p.id, quantity: 10, unitCostCents: 25000 }] }, t)).status).toBe(201);
    expect((await post("/v1/purchases", { supplierId: s.id, lines: [{ productId: p.id, quantity: 10, unitCostCents: 35000 }] }, t)).status).toBe(201);

    const now = await valuation(t);
    expect(now.total_cents).toBe("600000");
    expect(now.products[0]).toMatchObject({ on_hand: "20.000", avg_cost_cents: "30000" });

    const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
    expect((await valuation(t, `?asOf=${today}`)).total_cents).toBe("600000");
    expect((await valuation(t, "?asOf=2020-01-01")).total_cents).toBe("0");
    expect((await call("/v1/reports/stock-valuation?asOf=2020-02-30", { token: t })).status).toBe(400);

    expect((await valuation(await register("valuation-b"))).total_cents).toBe("0");
  });
});
