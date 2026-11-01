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
  const res = await call("/v1/auth/register", { method: "POST", body: JSON.stringify({ businessName: name, ownerName: "Owner", email: `${name}-${run}@pnl.ke`, phone: "0712345678", password: "correct-horse-1" }) });
  return ((await res.json()) as { accessToken: string }).accessToken;
};
type Statement = Record<string, string> & { expenses: Record<string, string> };
type Pnl = { months: Statement[]; total: Statement };

describe("profit and loss", () => {
  it("nets sales of VAT, takes off cost of goods and expenses by category, by month", async () => {
    const t = await register("pnl");
    expect((await post("/v1/shifts/open", { openingFloatCents: 0 }, t)).status).toBe(201);
    const p = (await (await post("/v1/products", { sku: "MAIZE", name: "Maize 2kg", retailPriceCents: 20000, taxCode: "A" }, t)).json()) as { id: string };
    expect((await post("/v1/stock/opening", { lines: [{ productId: p.id, quantity: 10, unitCostCents: 15000 }] }, t)).status).toBe(201);
    expect((await post("/v1/documents", { type: "SALE", idempotencyKey: `pnl-${run}`, lines: [{ productId: p.id, quantity: 3 }], payments: [{ method: "CASH", amountCents: 60000 }] }, t)).status).toBe(201);
    expect((await post("/v1/expenses", { category: "RENT", amountCents: 5000 }, t)).status).toBe(201);
    expect((await post("/v1/expenses", { category: "TRANSPORT", amountCents: 1000 }, t)).status).toBe(201);

    const pnl = (await (await call("/v1/reports/pnl", { token: t })).json()) as Pnl;
    expect(pnl.months).toHaveLength(1);
    expect(pnl.total).toMatchObject({ sales_cents: "60000", returns_cents: "0", net_sales_cents: "60000", cogs_cents: "45000",
      gross_profit_cents: "15000", expenses: { RENT: "5000", TRANSPORT: "1000" }, expenses_cents: "6000", net_profit_cents: "9000" });
    expect((await call("/v1/reports/pnl?from=2026-03-01&to=2026-02-01", { token: t })).status).toBe(400);

    expect(((await (await call("/v1/reports/pnl", { token: await register("pnl-b") })).json()) as Pnl).months).toEqual([]);
  });
});
