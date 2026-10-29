import { describe, expect, it } from "vitest";
import { app } from "../src/app";

const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://kpos_app:app@localhost:5432/kenya_pos",
  JWT_SECRET: "test-secret-test-secret-test-secret",
  APP_ORIGIN: "http://localhost:5173",
};
const run = Date.now();
const call = (method: string, path: string, token: string, body?: unknown) =>
  app.request(`http://api.test${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
const json = async <T = Record<string, any>>(r: Response | Promise<Response>) => (await (await r).json()) as T;

describe("shifts and returns", () => {
  it("cash-up nets sales and refunds; returns restock and cap quantities", async () => {
    const t = (await json(app.request("http://api.test/v1/auth/register", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ businessName: "shift", ownerName: "Owner", email: `shift-${run}@p.ke`, phone: "0712345678", password: "correct-horse-1" }) }, env))).accessToken as string;
    const p = await json(call("POST", "/v1/products", t, { sku: "MILK", name: "Milk 500ml", retailPriceCents: 6000 }));
    await call("POST", "/v1/stock/opening", t, { lines: [{ productId: p.id, quantity: 10, unitCostCents: 4000 }] });

    expect(await json(call("GET", "/v1/shifts/current", t))).toBeNull();
    const shift = await json(call("POST", "/v1/shifts/open", t, { openingFloatCents: 50000 }));
    expect((await call("POST", "/v1/shifts/open", t, { openingFloatCents: 0 })).status).toBe(409);

    const sale = await json(call("POST", "/v1/documents", t, { type: "SALE", lines: [{ productId: p.id, quantity: 3 }], payments: [{ method: "CASH", amountCents: 18000 }] }));
    await call("POST", "/v1/documents", t, { type: "SALE", lines: [{ productId: p.id, quantity: 1 }], payments: [{ method: "MPESA", amountCents: 6000, reference: `QX${run}` }] });

    const cn = await json(call("POST", `/v1/documents/${sale.id}/return`, t, { lines: [{ productId: p.id, quantity: 2 }], reason: "Expired" }));
    expect(cn).toMatchObject({ type: "CREDIT_NOTE", number: 1, total_cents: "12000" });
    expect((await call("POST", `/v1/documents/${sale.id}/return`, t, { lines: [{ productId: p.id, quantity: 2 }], reason: "Again" })).status).toBe(409);
    expect(await json(call("POST", `/v1/documents/${sale.id}/return`, t, { reason: "Rest" }))).toMatchObject({ total_cents: "6000" });
    expect((await call("POST", `/v1/documents/${sale.id}/return`, t, { reason: "None left" })).status).toBe(409);

    const gum = await json(call("POST", "/v1/products", t, { sku: "GUM", name: "Gum", retailPriceCents: 3, trackStock: false }));
    const g = await json(call("POST", "/v1/documents", t, { type: "SALE", lines: [{ productId: gum.id, quantity: 4 }], payments: [{ method: "CASH", amountCents: 12 }] }));
    let refunded = 0;
    for (let i = 0; i < 4; i++) refunded += Number((await json(call("POST", `/v1/documents/${g.id}/return`, t, { lines: [{ productId: gum.id, quantity: 1 }], reason: "Split" }))).total_cents);
    expect(refunded).toBe(12);

    const [row] = await json<any[]>(call("GET", "/v1/stock", t));
    expect(Number(row.on_hand)).toBe(9);

    const closed = await json(call("POST", `/v1/shifts/${shift.id}/close`, t, { countedCashCents: 49000 }));
    expect(closed).toMatchObject({ status: "CLOSED", expected_cash_cents: 50000, variance_cents: -1000 });
    expect(closed.by_method.map((m: any) => [m.method, Number(m.amount_cents)])).toEqual([["CASH", 0], ["MPESA", 6000]]);

    const rep = await json(call("GET", "/v1/reports/summary", t));
    expect(rep.returns).toMatchObject({ count: 6, total_cents: "18012" });
    const csv = await call("GET", "/v1/export/products", t);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toMatch(/^id,.*
.*MILK/s);
    expect((await call("GET", "/v1/export/users", t)).status).toBe(404);
    const alerts = await json(call("GET", "/v1/reports/alerts", t));
    expect(alerts).toMatchObject({ low_stock: [], overdue: [], pending_adjustments: 0, open_shifts: 0 });
  });
});
