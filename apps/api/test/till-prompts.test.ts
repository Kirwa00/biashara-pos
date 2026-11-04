import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";

const run = Date.now();
const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://kpos_app:app@localhost:5432/kenya_pos",
  JWT_SECRET: "test-secret-test-secret-test-secret",
  APP_ORIGIN: "http://localhost:5173",
  ENCRYPTION_KEY: "test-encryption-key",
  PAYHERO_BASE_URL: "https://payhero.test",
};
afterEach(() => vi.unstubAllGlobals());
const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  app.request(`http://api.test${path}`, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } }, env);
const send = (method: string, path: string, body: unknown, token: string) => call(path, { method, body: JSON.stringify(body), token });
const post = (path: string, body: unknown, token: string) => send("POST", path, body, token);
const json = async <T = Record<string, any>>(r: Response | Promise<Response>) => (await (await r).json()) as T;

/** PayHero stand-in: records what it was sent and reports `status` for prompts. */
const stubPayhero = (status: Record<string, unknown>) => {
  const sent: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("transaction-status")) return new Response(JSON.stringify(status));
    sent.push(JSON.parse(init!.body as string));
    return new Response(JSON.stringify({ success: true, status: "QUEUED", reference: `PH-${run}` }), { status: 201 });
  }));
  return sent;
};

async function setup(tag: string, opts: { stock?: number } = {}) {
  const token = (await json(post("/v1/auth/register", { businessName: tag, ownerName: "Owner", email: `${tag}-${run}@stk.ke`, phone: "0712345678", password: "correct-horse-1" }, ""))).accessToken as string;
  expect((await send("PUT", "/v1/settings/payments", { username: "ph-user", password: "ph-secret", channelId: 123 }, token)).status).toBe(200);
  const { callbackUrl } = await json(call("/v1/settings/payments", { token }));
  expect((await post("/v1/shifts/open", { openingFloatCents: 0 }, token)).status).toBe(201);
  const product = await json(post("/v1/products", { sku: "SUGAR", name: "Sugar", retailPriceCents: 10000, trackStock: opts.stock !== undefined }, token));
  if (opts.stock !== undefined) await post("/v1/stock/opening", { lines: [{ productId: product.id, quantity: opts.stock, unitCostCents: 5000 }] }, token);
  const prompt = (over: Record<string, unknown> = {}) => post("/v1/payments/till-prompts", { idempotencyKey: crypto.randomUUID(), phone: "+254712345678", expectedTotalCents: 10000, lines: [{ productId: product.id, quantity: 1 }], ...over }, token);
  const hook = (id: string) => call(new URL(callbackUrl).pathname, { method: "POST", body: JSON.stringify({ response: { ExternalReference: id } }) });
  const status = (id: string) => json(call(`/v1/payments/till-prompts/${id}`, { token }));
  const sales = () => json<{ id: string; status: string; total_cents: string }[]>(call("/v1/documents?type=SALE", { token }));
  return { token, product, prompt, hook, status, sales };
}

describe("M-Pesa prompts from the till", () => {
  it("a walk-in sale: the prompt goes out in PayHero's 07 format, and the sale exists only once paid", async () => {
    const { prompt, hook, status, sales, token } = await setup("walkin", { stock: 5 });
    const sent = stubPayhero({ status: "QUEUED" });
    const { promptId } = await json(prompt());
    expect(sent[0]).toMatchObject({ amount: 100, phone_number: "0712345678", channel_id: 123, provider: "m-pesa", external_reference: promptId });

    // Waiting: no sale, no stock taken.
    expect(await status(promptId)).toMatchObject({ status: "PENDING", document_id: null });
    expect(await sales()).toEqual([]);
    expect(Number((await json<{ on_hand: string }[]>(call("/v1/stock", { token })))[0]!.on_hand)).toBe(5);

    stubPayhero({ status: "SUCCESS", provider_reference: `WALK${run}`.slice(0, 12), amount: 100, reference: `PH-${run}` });
    for (let i = 0; i < 2; i++) expect((await hook(promptId)).status).toBe(200);
    const done = await status(promptId);
    expect(done).toMatchObject({ status: "CONFIRMED", number: 1, total_cents: "10000" });

    const recorded = await sales();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ id: done.document_id, status: "PAID", total_cents: "10000" });
    expect(Number((await json<{ on_hand: string }[]>(call("/v1/stock", { token })))[0]!.on_hand)).toBe(4);
    const shift = await json(call("/v1/shifts/current", { token }));
    expect(shift.by_method.map((m: any) => [m.method, Number(m.amount_cents)])).toEqual([["MPESA", 10000]]);
  });

  it("a cancelled prompt leaves nothing behind", async () => {
    const { prompt, hook, status, sales, token } = await setup("cancelled", { stock: 5 });
    stubPayhero({ status: "QUEUED" });
    const { promptId } = await json(prompt());
    stubPayhero({ status: "FAILED", reference: `PH-${run}` });
    expect((await hook(promptId)).status).toBe(200);
    expect(await status(promptId)).toMatchObject({ status: "FAILED", document_id: null });
    expect(await sales()).toEqual([]);
    expect(Number((await json<{ on_hand: string }[]>(call("/v1/stock", { token })))[0]!.on_hand)).toBe(5);
    expect(await json<unknown[]>(call("/v1/etims/invoices", { token }))).toEqual([]);
  });

  it("a double tap sends one prompt; a changed price or a closed till sends none", async () => {
    const { prompt, token } = await setup("guards");
    const sent = stubPayhero({ status: "QUEUED" });
    const idempotencyKey = crypto.randomUUID();
    const first = await json(prompt({ idempotencyKey }));
    expect((await json(prompt({ idempotencyKey }))).promptId).toBe(first.promptId);
    expect(sent).toHaveLength(1);

    expect((await prompt({ expectedTotalCents: 9000 })).status).toBe(409);
    expect(sent).toHaveLength(1);

    const shift = await json(call("/v1/shifts/current", { token }));
    expect((await post(`/v1/shifts/${shift.id}/close`, { countedCashCents: 0 }, token)).status).toBe(200);
    expect((await prompt()).status).toBe(409);
    expect(sent).toHaveLength(1);
  });

  it("refuses to charge for stock that isn't there, or for part-shilling totals", async () => {
    const low = await setup("lowstock", { stock: 0 });
    const sent = stubPayhero({ status: "QUEUED" });
    const res = await low.prompt();
    expect(res.status).toBe(409);
    expect((await json(res)).error).toContain("Insufficient stock");

    const cents = await setup("cents");
    const gum = await json(post("/v1/products", { sku: "GUM", name: "Gum", retailPriceCents: 150, trackStock: false }, cents.token));
    expect((await cents.prompt({ expectedTotalCents: 150, lines: [{ productId: gum.id, quantity: 1 }] })).status).toBe(422);
    expect(sent).toHaveLength(0);
  });

  it("if stock runs out while the customer enters their PIN, the payment is flagged rather than lost", async () => {
    const { prompt, hook, status, sales, product, token } = await setup("raced", { stock: 1 });
    stubPayhero({ status: "QUEUED" });
    const { promptId } = await json(prompt());
    expect((await post("/v1/documents", { type: "SALE", lines: [{ productId: product.id, quantity: 1 }], payments: [{ method: "CASH", amountCents: 10000 }] }, token)).status).toBe(201);

    stubPayhero({ status: "SUCCESS", provider_reference: `RACE${run}`.slice(0, 12), amount: 100, reference: `PH-${run}` });
    expect((await hook(promptId)).status).toBe(200);
    const flagged = await status(promptId);
    expect(flagged).toMatchObject({ status: "REVIEW", reference: `RACE${run}`.slice(0, 12) });
    expect(flagged.error).toContain("Insufficient stock");
    expect(await sales()).toHaveLength(1); // only the cash sale
  });

  it("records the sale even if the till shift closed while the customer was paying, and flags a wrong amount", async () => {
    const { prompt, hook, status, sales, token } = await setup("lateclose");
    stubPayhero({ status: "QUEUED" });
    const { promptId } = await json(prompt());
    const shift = await json(call("/v1/shifts/current", { token }));
    expect((await post(`/v1/shifts/${shift.id}/close`, { countedCashCents: 0 }, token)).status).toBe(200);
    stubPayhero({ status: "SUCCESS", provider_reference: `LATE${run}`.slice(0, 12), amount: 100, reference: `PH-${run}` });
    await hook(promptId);
    expect(await status(promptId)).toMatchObject({ status: "CONFIRMED" });
    expect(await sales()).toHaveLength(1);

    const other = await setup("wrongsum");
    stubPayhero({ status: "QUEUED" });
    const second = await json(other.prompt());
    stubPayhero({ status: "SUCCESS", provider_reference: `SUM${run}`.slice(0, 12), amount: 5, reference: `PH-${run}` });
    await other.hook(second.promptId);
    expect(await other.status(second.promptId)).toMatchObject({ status: "REVIEW" });
    expect(await other.sales()).toEqual([]);
  });

  it("a cashier can use it; another business can't see it", async () => {
    const { prompt, token } = await setup("access");
    stubPayhero({ status: "QUEUED" });
    const { promptId } = await json(prompt());
    const other = await setup("otherbiz");
    expect((await call(`/v1/payments/till-prompts/${promptId}`, { token: other.token })).status).toBe(404);
    expect((await call("/v1/payments/till-prompts/not-a-uuid", { token })).status).toBe(404);

    await post("/v1/users/till", { name: "Teller", username: "teller", pin: "4827" }, token);
    const code = (await json(call("/v1/me", { token }))).business.shop_code as string;
    const teller = (await json(post("/v1/auth/till", { shopCode: code, username: "teller", pin: "4827" }, ""))).accessToken as string;
    expect((await post("/v1/shifts/open", { openingFloatCents: 0 }, teller)).status).toBe(201);
    const products = await json<{ id: string }[]>(call("/v1/products", { token: teller }));
    stubPayhero({ status: "QUEUED" });
    expect((await post("/v1/payments/till-prompts", { idempotencyKey: crypto.randomUUID(), phone: "0712345678", expectedTotalCents: 10000, lines: [{ productId: products[0]!.id, quantity: 1 }] }, teller)).status).toBe(202);
  });
});
