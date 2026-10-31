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
const register = async (tag: string) =>
  (await json<{ accessToken: string }>(post("/v1/auth/register", { businessName: tag, ownerName: "Owner", email: `${tag}-${run}@p.ke`, phone: "0712345678", password: "correct-horse-1" }, ""))).accessToken;
const stubPayhero = (body: (ref: string) => BodyInit) =>
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(body(new URL(url).searchParams.get("reference") ?? ""))));

afterEach(() => vi.unstubAllGlobals());

describe("frame follow-ups", () => {
  it("statement balance ignores refunded credit notes; eTIMS is honest and nets credit notes", async () => {
    const t = await register("stmt");
    const p = await json<{ id: string }>(post("/v1/products", { sku: "RICE", name: "Rice", retailPriceCents: 11600, trackStock: false }, t));
    const cust = await json<{ id: string }>(post("/v1/customers", { name: "Mama Duka", creditLimitCents: 1000000 }, t));
    const sale = await json<{ id: string; tax_cents: string }>(post("/v1/documents", { type: "SALE", customerId: cust.id, lines: [{ productId: p.id, quantity: 1 }], payments: [{ method: "CASH", amountCents: 11600 }] }, t));
    expect((await post(`/v1/documents/${sale.id}/return`, { reason: "Damaged" }, t)).status).toBe(201);
    const inv = await json<{ tax_cents: string }>(post("/v1/documents", { type: "INVOICE", customerId: cust.id, lines: [{ productId: p.id, quantity: 2 }] }, t));

    const st = await json<{ summary: { balanceCents: number }; payments: { amount_cents: string }[] }>(call(`/v1/customers/${cust.id}/statement`, { token: t }));
    expect(st.summary.balanceCents).toBe(23200);
    expect(st.payments.map((x) => Number(x.amount_cents)).sort((a, b) => a - b)).toEqual([-11600, 11600]);

    const s = await json<{ connection: { status: string }; vatSummary: { totalVatCents: number; pendingInvoices: number; submittedInvoices: number } }>(call("/v1/etims/summary", { token: t }));
    expect(s.connection.status).toBe("NOT_CONNECTED");
    expect(s.vatSummary).toMatchObject({ totalVatCents: Number(inv.tax_cents), pendingInvoices: 3, submittedInvoices: 0 });
    const docs = await json<{ etimsStatus: string; cuInvoiceNumber: string | null }[]>(call("/v1/etims/invoices", { token: t }));
    expect(docs.every((d) => d.etimsStatus === "PENDING" && d.cuInvoiceNumber === null)).toBe(true);
    expect(await json<unknown[]>(call("/v1/etims/invoices?period=2001-01", { token: t }))).toEqual([]);
  });

  it("M-Pesa code checks: idempotent retry during outage, garbled replies, other channels", async () => {
    const t = await register("mpx");
    const p = await json<{ id: string }>(post("/v1/products", { sku: "SALT", name: "Salt", retailPriceCents: 5000, trackStock: false }, t));
    expect((await send("PUT", "/v1/settings/payments", { username: "ph-user", password: "ph-secret", channelId: 123 }, t)).status).toBe(200);
    const sale = (code: string, key?: string) => post("/v1/documents", { type: "SALE", idempotencyKey: key, lines: [{ productId: p.id, quantity: 1 }], payments: [{ method: "MPESA", amountCents: 5000, reference: code }] }, t);

    stubPayhero((ref) => JSON.stringify({ status: "SUCCESS", provider_reference: ref, amount: 50, channel_id: 123 }));
    const first = await json<{ id: string }>(sale(`K${run}`, `idem-${run}`));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect((await json<{ id: string }>(sale(`K${run}`, `idem-${run}`))).id).toBe(first.id);

    stubPayhero(() => "<html>oops</html>");
    expect((await sale(`G${run}`)).status).toBe(503);
    stubPayhero((ref) => JSON.stringify({ status: "SUCCESS", provider_reference: ref, amount: 50, channel_id: 999 }));
    expect((await sale(`H${run}`)).status).toBe(422);
  });
});
