import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { withTenant } from "../src/db";

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
/** Registers a business and opens the owner's till shift, which till sales need. */
const register = async (tag: string) => {
  const t = (await json<{ accessToken: string }>(post("/v1/auth/register", { businessName: tag, ownerName: "Owner", email: `${tag}-${run}@p.ke`, phone: "0712345678", password: "correct-horse-1" }, ""))).accessToken;
  expect((await post("/v1/shifts/open", { openingFloatCents: 0 }, t)).status).toBe(201);
  return t;
};
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
    expect(docs.every((d) => d.etimsStatus === "QUEUED" && d.cuInvoiceNumber === null)).toBe(true);
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

  it("offline replay is rejected, not re-priced, when the total changed", async () => {
    const t = await register("offl");
    const p = await json<{ id: string }>(post("/v1/products", { sku: "SUGAR", name: "Sugar", retailPriceCents: 10000, trackStock: false }, t));
    const sale = (expectedTotalCents: number) =>
      post("/v1/documents", { type: "SALE", expectedTotalCents, lines: [{ productId: p.id, quantity: 1 }], payments: [{ method: "CASH", amountCents: expectedTotalCents }] }, t);
    expect((await sale(9000)).status).toBe(409);
    expect((await sale(10000)).status).toBe(201);
  });

  it("wholesale customers are charged wholesale prices", async () => {
    const t = await register("whsl");
    const p = await json<{ id: string }>(post("/v1/products", { sku: "RICE", name: "Rice", retailPriceCents: 10000, wholesalePriceCents: 9000, wholesaleMinQty: 10, trackStock: false }, t));
    const c = await json<{ id: string }>(post("/v1/customers", { name: "Duka Wholesale", priceTier: "WHOLESALE" }, t));
    const res = await post("/v1/documents", { type: "SALE", customerId: c.id, expectedTotalCents: 9000, lines: [{ productId: p.id, quantity: 1 }], payments: [{ method: "CASH", amountCents: 9000 }] }, t);
    expect(res.status).toBe(201);
  });

  it("a waiting M-Pesa prompt reserves the balance; a late confirmation never overpays", async () => {
    const t = await register("stkx");
    const p = await json<{ id: string }>(post("/v1/products", { sku: "SALT", name: "Salt", retailPriceCents: 5000, trackStock: false }, t));
    const cust = await json<{ id: string }>(post("/v1/customers", { name: "Duka Prompt", creditLimitCents: 1000000 }, t));
    const inv = await json<{ id: string; total_cents: string }>(post("/v1/documents", { type: "INVOICE", customerId: cust.id, lines: [{ productId: p.id, quantity: 2 }] }, t));
    expect(inv.total_cents).toBe("10000");
    expect((await send("PUT", "/v1/settings/payments", { username: "ph-user", password: "ph-secret", channelId: 123 }, t)).status).toBe(200);
    const { callbackUrl } = await json<{ callbackUrl: string }>(call("/v1/settings/payments", { token: t }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes("transaction-status")
      ? { status: "SUCCESS", provider_reference: `S${run}`, amount: 100, reference: "PH-STK-X" } : { success: true, reference: "PH-STK-X" }))));

    const stk = await json<{ paymentId: string }>(post("/v1/payments/stk", { documentId: inv.id, phone: "0712345678", amountCents: 10000 }, t));
    expect((await post("/v1/payments/stk", { documentId: inv.id, phone: "0712345678", amountCents: 10000 }, t)).status).toBe(422);
    // The cashier gives up on the prompt and takes a bank transfer; then the customer approves the prompt anyway.
    expect((await post(`/v1/documents/${inv.id}/payments`, { method: "BANK", amountCents: 10000, reference: "EFT-STK" }, t)).status).toBe(201);
    expect((await call(new URL(callbackUrl).pathname, { method: "POST", body: JSON.stringify({ response: { ExternalReference: stk.paymentId } }) })).status).toBe(200);
    expect(await json(call(`/v1/payments/${stk.paymentId}`, { token: t }))).toMatchObject({ status: "PENDING" });
    expect(await json(call(`/v1/documents/${inv.id}`, { token: t }))).toMatchObject({ status: "PAID", paid_cents: "10000" });
  });

  it("till sales and cash refunds need an open shift", async () => {
    const t = (await json<{ accessToken: string }>(post("/v1/auth/register", { businessName: "noshift", ownerName: "Owner", email: `noshift-${run}@p.ke`, phone: "0712345678", password: "correct-horse-1" }, ""))).accessToken;
    const p = await json<{ id: string }>(post("/v1/products", { sku: "TEA", name: "Tea", retailPriceCents: 3000, trackStock: false }, t));
    const sale = () => post("/v1/documents", { type: "SALE", lines: [{ productId: p.id, quantity: 1 }], payments: [{ method: "CASH", amountCents: 3000 }] }, t);
    expect((await sale()).status).toBe(409);
    const shift = await json<{ id: string }>(post("/v1/shifts/open", { openingFloatCents: 0 }, t));
    const s = await json<{ id: string }>(sale());
    expect((await post(`/v1/shifts/${shift.id}/close`, { countedCashCents: 3000 }, t)).status).toBe(200);
    expect((await post(`/v1/documents/${s.id}/return`, { reason: "Spilled" }, t)).status).toBe(409);
    expect((await post(`/v1/documents/${s.id}/return`, { reason: "Spilled", method: "BANK", reference: "EFT-RF1" }, t)).status).toBe(201);
  });

  it("re-checks a prompt whose callback was lost: SUCCESS is applied, FAILED released, anything else stays reserved", async () => {
    const t = await register("lost");
    const { business } = await json<{ business: { id: string } }>(call("/v1/me", { token: t }));
    const p = await json<{ id: string }>(post("/v1/products", { sku: "SALT", name: "Salt", retailPriceCents: 5000, trackStock: false }, t));
    const cust = await json<{ id: string }>(post("/v1/customers", { name: "Duka Lost", creditLimitCents: 1000000 }, t));
    expect((await send("PUT", "/v1/settings/payments", { username: "ph-user", password: "ph-secret", channelId: 123 }, t)).status).toBe(200);
    let status: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes("transaction-status") ? status : { success: true, reference: "PH-LOST" }))));
    const invoice = () => json<{ id: string }>(post("/v1/documents", { type: "INVOICE", customerId: cust.id, lines: [{ productId: p.id, quantity: 2 }] }, t));
    const prompt = (documentId: string) => post("/v1/payments/stk", { documentId, phone: "0712345678", amountCents: 10000 }, t);
    const sql = postgres(env.DATABASE_URL, { max: 1 });
    const age = (id: string) => withTenant(sql, business.id, (tx) => tx`UPDATE payments SET created_at = now() - interval '4 minutes' WHERE id = ${id}`);
    const paymentStatus = async (id: string) => (await json<{ status: string }>(call(`/v1/payments/${id}`, { token: t }))).status;
    try {
      const paid = await invoice();
      const a = await json<{ paymentId: string }>(prompt(paid.id));
      await age(a.paymentId);
      status = { status: "SUCCESS", provider_reference: `L${run}`, amount: 100, reference: "PH-LOST" };
      expect((await prompt(paid.id)).status).toBe(422); // settled by the re-check, so nothing is left to charge
      expect(await paymentStatus(a.paymentId)).toBe("CONFIRMED");
      expect(await json(call(`/v1/documents/${paid.id}`, { token: t }))).toMatchObject({ status: "PAID", paid_cents: "10000" });

      const unclear = await invoice();
      const b = await json<{ paymentId: string }>(prompt(unclear.id));
      await age(b.paymentId);
      status = { status: "QUEUED", reference: "PH-LOST" };
      expect((await prompt(unclear.id)).status).toBe(422);
      expect(await paymentStatus(b.paymentId)).toBe("PENDING");

      status = { status: "FAILED", reference: "PH-LOST" };
      expect((await prompt(unclear.id)).status).toBe(202);
      expect(await paymentStatus(b.paymentId)).toBe("FAILED");
    } finally {
      await sql.end();
    }
  });
});
