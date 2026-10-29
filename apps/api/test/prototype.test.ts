import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";

const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://kpos_app:app@localhost:5432/kenya_pos",
  JWT_SECRET: "test-secret-test-secret-test-secret",
  APP_ORIGIN: "http://localhost:5173",
  ENCRYPTION_KEY: "test-encryption-key",
  PAYHERO_BASE_URL: "https://payhero.test",
};
const run = Date.now();
const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  app.request(`http://api.test${path}`, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } }, env);
const send = (method: string, path: string, body: unknown, token: string) => call(path, { method, body: JSON.stringify(body), token });
const post = (path: string, body: unknown, token: string) => send("POST", path, body, token);
const json = async <T = Record<string, unknown>>(r: Response | Promise<Response>) => (await (await r).json()) as T;

afterEach(() => vi.unstubAllGlobals());

describe("prototype flows", () => {
  it("sells, invoices, receives stock, takes M-Pesa via PayHero and reports", async () => {
    const t = (await json<{ accessToken: string }>(post("/v1/auth/register", { businessName: "proto", ownerName: "Owner", email: `proto-${run}@p.ke`, phone: "0712345678", password: "correct-horse-1" }, ""))).accessToken;
    const p = await json<{ id: string }>(post("/v1/products", { sku: "SUGAR", name: "Sugar 1kg", retailPriceCents: 20000, wholesalePriceCents: 18000, wholesaleMinQty: 10, reorderLevel: 2 }, t));
    const sup = await json<{ id: string }>(post("/v1/suppliers", { name: "Mumias Distributors" }, t));
    expect((await post("/v1/purchases", { supplierId: sup.id, lines: [{ productId: p.id, quantity: 20, unitCostCents: 15000 }] }, t)).status).toBe(201);

    expect((await post("/v1/documents", { type: "SALE", lines: [{ productId: p.id, quantity: 2 }], payments: [{ method: "CASH", amountCents: 10000 }] }, t)).status).toBe(422);
    const sale = await json(post("/v1/documents", { type: "SALE", idempotencyKey: `till-${run}-1`, lines: [{ productId: p.id, quantity: 2 }], payments: [{ method: "CASH", amountCents: 40000 }] }, t));
    expect(sale).toMatchObject({ number: 1, status: "PAID", total_cents: "40000" });
    const again = await json(post("/v1/documents", { type: "SALE", idempotencyKey: `till-${run}-1`, lines: [{ productId: p.id, quantity: 2 }], payments: [{ method: "CASH", amountCents: 40000 }] }, t));
    expect(again.id).toBe(sale.id);

    const cust = await json<{ id: string }>(post("/v1/customers", { name: "Duka la Mama", creditLimitCents: 500000, paymentTermsDays: 14 }, t));
    const quote = await json<{ id: string }>(post("/v1/documents", { type: "QUOTE", customerId: cust.id, lines: [{ productId: p.id, quantity: 10 }] }, t));
    const inv = await json<{ id: string; total_cents: string; status: string }>(post(`/v1/documents/${quote.id}/convert`, {}, t));
    expect(inv).toMatchObject({ total_cents: "180000", status: "UNPAID" });
    expect((await post(`/v1/documents/${quote.id}/convert`, {}, t)).status).toBe(409);
    expect((await post(`/v1/documents/${inv.id}/payments`, { method: "BANK", amountCents: 80000, reference: "EFT-001" }, t)).status).toBe(201);

    expect((await post("/v1/payments/stk", { documentId: inv.id, phone: "0712345678", amountCents: 100000 }, t)).status).toBe(409);
    expect((await send("PUT", "/v1/settings/payments", { username: "ph-user", password: "ph-secret", channelId: 123 }, t)).status).toBe(200);
    const settings = await json<{ configured: boolean; callbackUrl: string; password?: string }>(call("/v1/settings/payments", { token: t }));
    expect(settings.configured).toBe(true);
    expect(JSON.stringify(settings)).not.toContain("ph-secret");

    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => new Response(JSON.stringify(String(url).includes("transaction-status")
      ? { status: "SUCCESS", provider_reference: `QK${run}`, amount: 1000, reference: "PH-REF-1" } : { success: true, reference: "PH-REF-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const stk = await json<{ paymentId: string }>(post("/v1/payments/stk", { documentId: inv.id, phone: "0712345678", amountCents: 100000 }, t));
    const sent = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(sent).toMatchObject({ amount: 1000, phone_number: "254712345678", channel_id: 123, external_reference: stk.paymentId });

    const hook = new URL(settings.callbackUrl).pathname;
    expect((await call("/v1/webhooks/payhero/not-a-token", { method: "POST", body: "{}" })).status).toBe(404);
    for (let i = 0; i < 2; i++)
      expect((await call(hook, { method: "POST", body: JSON.stringify({ response: { ExternalReference: stk.paymentId, ResultCode: 0 } }) })).status).toBe(200);
    const paid = await json<{ status: string; paid_cents: string }>(call(`/v1/documents/${inv.id}`, { token: t }));
    expect(paid).toMatchObject({ status: "PAID", paid_cents: "180000" });

    const rep = await json<{ sales: { count: number; total_cents: string }; gross_profit_cents: string; receivable_cents: string; stock_value_cents: string; received: { method: string }[] }>(call("/v1/reports/summary", { token: t }));
    expect(rep.sales).toMatchObject({ count: 2, total_cents: "220000" });
    expect(rep.receivable_cents).toBe("0");
    expect(rep.stock_value_cents).toBe("120000");
    expect(rep.received.map((r) => r.method)).toEqual(["BANK", "CASH", "MPESA"]);
  });
});
