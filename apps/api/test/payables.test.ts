import { describe, expect, it } from "vitest";
import { app } from "../src/app";

const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://kpos_app:app@localhost:5432/kenya_pos",
  JWT_SECRET: "test-secret-test-secret-test-secret",
  APP_ORIGIN: "http://localhost:5173",
};
const run = Date.now();
const call = (path: string, init: RequestInit & { token?: string; type?: string } = {}) =>
  app.request(path, { ...init, headers: { "content-type": init.type ?? "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } }, env);
const register = async (name: string) => {
  const res = await call("/v1/auth/register", { method: "POST", body: JSON.stringify({ businessName: name, ownerName: "Owner", email: `${name}-${run}@pay.ke`, phone: "0712345678", password: "correct-horse-1" }) });
  return ((await res.json()) as { accessToken: string }).accessToken;
};

const post = (path: string, body: unknown, token: string) => call(path, { method: "POST", body: JSON.stringify(body), token });

describe("payables and expenses", () => {
  it("tracks what is owed to a supplier, refuses overpayment, and nets expenses into profit", async () => {
    const t = await register("payables");
    const s = (await (await post("/v1/suppliers", { name: "Unga Ltd" }, t)).json()) as { id: string };
    const p = (await (await post("/v1/products", { sku: "UNGA", name: "Unga 2kg", retailPriceCents: 20000 }, t)).json()) as { id: string };
    expect((await post("/v1/purchases", { supplierId: s.id, lines: [{ productId: p.id, quantity: 10, unitCostCents: 5000 }] }, t)).status).toBe(201);

    expect((await post(`/v1/suppliers/${s.id}/payments`, { amountCents: 20000, method: "BANK", reference: "TRF1" }, t)).status).toBe(201);
    expect((await post(`/v1/suppliers/${s.id}/payments`, { amountCents: 40000 }, t)).status).toBe(409);
    const [sup] = (await (await call("/v1/suppliers", { token: t })).json()) as { balance_cents: string }[];
    expect(sup!.balance_cents).toBe("30000");

    expect((await post("/v1/expenses", { category: "RENT", amountCents: 10000 }, t)).status).toBe(201);
    expect((await post("/v1/expenses", { category: "BRIBES", amountCents: 1 }, t)).status).toBe(400);
    const sum = (await (await call("/v1/reports/summary", { token: t })).json()) as Record<string, string>;
    expect(sum).toMatchObject({ expenses_cents: "10000", net_profit_cents: "-10000", payable_cents: "30000" });

    const other = await register("payables-b");
    expect(await (await call("/v1/expenses", { token: other })).json()).toEqual([]);
    expect((await post(`/v1/suppliers/${s.id}/payments`, { amountCents: 100 }, other)).status).toBe(404);
  });
});
