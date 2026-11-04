import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { runBillingJob } from "../src/billing";
import { withTenant } from "../src/db";

const run = Date.now();
const sellerEmail = `seller-${run}@biasharapos.test`;
const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://kpos_app:app@localhost:5432/kenya_pos",
  JWT_SECRET: "test-secret-test-secret-test-secret",
  APP_ORIGIN: "http://localhost:5173",
  ENCRYPTION_KEY: "test-encryption-key",
  PAYHERO_BASE_URL: "https://payhero.test",
  SUPER_ADMIN_EMAILS: sellerEmail,
};
const sql = postgres(env.DATABASE_URL, { max: 2, onnotice: () => {} });
afterAll(() => sql.end());
afterEach(() => vi.unstubAllGlobals());

const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  app.request(`http://api.test${path}`, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } }, env);
const send = (method: string, path: string, body: unknown, token: string) => call(path, { method, body: JSON.stringify(body), token });
const post = (path: string, body: unknown, token: string) => send("POST", path, body, token);
const json = async <T = Record<string, any>>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const register = async (tag: string, email = `${tag}-${run}@shop.test`) => {
  const token = (await json(post("/v1/auth/register", { businessName: tag, ownerName: "Owner", email, phone: "0712345678", password: "correct-horse-1" }, ""))).accessToken as string;
  const bid = (await json(call("/v1/me", { token }))).business.id as string;
  return { token, bid };
};
const DAY = 86_400_000;
/** Moves the end of a business's trial or paid period to `days` from now. */
const endIn = (bid: string, days: number, column: "trial_ends_at" | "paid_until" = "trial_ends_at") => {
  const at = new Date(Date.now() + days * DAY);
  return withTenant(sql, bid, async (tx) => {
    await tx`UPDATE businesses SET trial_ends_at = ${column === "trial_ends_at" ? at : new Date(Date.now() - 30 * DAY)}, paid_until = ${column === "paid_until" ? at : null} WHERE id = ${bid}`;
  });
};
const product = (token: string, sku: string) => post("/v1/products", { sku, name: `Thing ${sku}`, retailPriceCents: 1000, trackStock: false }, token);

/** PayHero stand-in: accepts prompts and reports `status` for them. */
const stubPayhero = (status: Record<string, unknown>) => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url).includes("transaction-status")) return new Response(JSON.stringify(status));
    return new Response(JSON.stringify({ success: true, reference: `PH-${JSON.parse(init!.body as string).external_reference}` }));
  }));
  return calls;
};

describe("subscription billing", () => {
  it("runs from trial to paid: plans in the seller's catalog, invoice only on confirmed money, no double credit", async () => {
    const seller = await register("seller", sellerEmail);
    expect((await send("PUT", "/v1/settings/payments", { username: "ph-user", password: "ph-secret", channelId: 123 }, seller.token)).status).toBe(200);
    const { callbackUrl } = await json(call("/v1/settings/payments", { token: seller.token }));

    const shop = await register("shop");
    const me = await json(call("/v1/me", { token: shop.token }));
    expect(me.billing).toMatchObject({ kind: "TRIAL", daysLeft: 14 });
    expect((await json(call("/v1/me", { token: seller.token }))).billing).toBeNull();

    const billing = await json(call("/v1/billing", { token: shop.token }));
    expect(billing.prices).toContainEqual(expect.objectContaining({ plan: "STARTER", cycle: "MONTHLY", amountCents: 360000 }));
    expect(billing.prices).toContainEqual(expect.objectContaining({ plan: "COMMERCIAL", cycle: "ANNUAL", amountCents: 17760000 }));
    const skus = (await json<{ sku: string }[]>(call("/v1/products", { token: seller.token }))).map((p) => p.sku);
    expect(skus).toContain("PLAN-STARTER-MONTHLY");

    const code = `SUB${run}`.slice(0, 12);
    const calls = stubPayhero({ status: "QUEUED" });
    const pay = await json(post("/v1/billing/pay", { plan: "STARTER", cycle: "MONTHLY", phone: "0712345678" }, shop.token));
    expect(pay).toMatchObject({ amountCents: 360000 });
    expect(calls.at(-1)).toContain("/api/v2/payments");
    // A second prompt can't go out while one is waiting, and nothing is in the seller's books yet.
    expect((await post("/v1/billing/pay", { plan: "STARTER", cycle: "MONTHLY", phone: "0712345678" }, shop.token)).status).toBe(409);
    expect(await json<unknown[]>(call("/v1/documents?type=INVOICE", { token: seller.token }))).toEqual([]);

    stubPayhero({ status: "SUCCESS", provider_reference: code, amount: 3600 });
    for (let i = 0; i < 2; i++)
      expect((await call(new URL(callbackUrl).pathname, { method: "POST", body: JSON.stringify({ response: { ExternalReference: pay.paymentId } }) })).status).toBe(200);

    const after = await json(call("/v1/billing", { token: shop.token }));
    expect(after).toMatchObject({ plan: "STARTER", cycle: "MONTHLY", state: { kind: "ACTIVE" } });
    // A month on top of the unused trial, once only.
    const days = (new Date(after.paidUntil).getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(41);
    expect(days).toBeLessThan(46);
    expect(after.payments[0]).toMatchObject({ status: "CONFIRMED", reference: code.toUpperCase() });

    const invoices = await json<{ id: string; status: string; total_cents: string; customer_name: string }[]>(call("/v1/documents?type=INVOICE", { token: seller.token }));
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ status: "PAID", total_cents: "360000", customer_name: "shop" });
  });

  it("warns during grace, then goes read-only: reads, export and paying stay open, and the seller is never restricted", async () => {
    const shop = await register("lapse");
    await endIn(shop.bid, -2);
    expect((await json(call("/v1/me", { token: shop.token }))).billing).toMatchObject({ kind: "GRACE" });
    expect((await product(shop.token, "GRACE1")).status).toBe(201);

    await endIn(shop.bid, -4);
    expect((await json(call("/v1/me", { token: shop.token }))).billing).toMatchObject({ kind: "LAPSED" });
    const blocked = await product(shop.token, "LAPSED1");
    expect(blocked.status).toBe(402);
    expect((await json(blocked)).error).toContain("Billing");
    expect((await call("/v1/products", { token: shop.token })).status).toBe(200);
    expect((await call("/v1/export/products", { token: shop.token })).status).toBe(200);
    expect((await call("/v1/billing", { token: shop.token })).status).toBe(200);
    expect((await send("PUT", "/v1/billing/plan", { plan: "STARTER", cycle: "ANNUAL", phone: "0712345678" }, shop.token)).status).toBe(200);
    expect((await post("/v1/auth/logout", {}, shop.token)).status).toBe(204);

    const seller = await json(post("/v1/auth/login", { email: sellerEmail, password: "correct-horse-1" }, ""));
    const sellerBid = (await json(call("/v1/me", { token: seller.accessToken }))).business.id as string;
    await endIn(sellerBid, -30);
    expect((await product(seller.accessToken, `SELLER${run}`)).status).toBe(201);
    await endIn(sellerBid, 14);
  });

  it("only the owner can see or pay billing", async () => {
    const shop = await register("owneronly");
    await post("/v1/users", { name: "Till One", email: `till-${run}@shop.test`, role: "CASHIER", password: "cashier-pass-1" }, shop.token);
    const cashier = (await json(post("/v1/auth/login", { email: `till-${run}@shop.test`, password: "cashier-pass-1" }, ""))).accessToken as string;
    expect((await call("/v1/billing", { token: cashier })).status).toBe(403);
    expect((await post("/v1/billing/pay", { plan: "STARTER", cycle: "MONTHLY", phone: "0712345678" }, cashier)).status).toBe(403);
    expect((await json(call("/v1/me", { token: cashier }))).billing).toMatchObject({ kind: "TRIAL" });
  });

  it("enforces plan limits, and a chosen plan only takes effect once paid", async () => {
    const shop = await register("limits");
    const branch = (code: string) => post("/v1/branches", { name: `Branch ${code}`, code }, shop.token);
    expect((await branch("TWO")).status).toBe(201); // trial: Commercial limits

    // Two branches don't fit Starter, either to pay for or to save.
    expect((await send("PUT", "/v1/billing/plan", { plan: "STARTER", cycle: "MONTHLY", phone: "0712345678" }, shop.token)).status).toBe(409);
    expect((await post("/v1/billing/pay", { plan: "STARTER", cycle: "MONTHLY", phone: "0712345678" }, shop.token)).status).toBe(409);

    // Choosing Commercial for later doesn't change today's limits; setting a smaller plan via payment would.
    expect((await send("PUT", "/v1/billing/plan", { plan: "COMMERCIAL", cycle: "MONTHLY", phone: "0712345678" }, shop.token)).status).toBe(200);
    expect(await json(call("/v1/billing", { token: shop.token }))).toMatchObject({ plan: null, nextPlan: "COMMERCIAL" });
    for (const c of ["THREE", "FOUR", "FIVE"]) expect((await branch(c)).status).toBe(201);
    const over = await branch("SIX");
    expect(over.status).toBe(409);
    expect((await json(over)).error).toContain("Commercial Wholesale");

    const small = await register("starter");
    await withTenant(sql, small.bid, (tx) => tx`UPDATE businesses SET plan = 'STARTER' WHERE id = ${small.bid}`);
    expect((await post("/v1/branches", { name: "Second", code: "TWO" }, small.token)).status).toBe(409);
    await withTenant(sql, small.bid, async (tx) => {
      await tx`INSERT INTO products (business_id, sku, name, retail_price_cents, track_stock) SELECT ${small.bid}, 'BULK-' || g, 'Bulk', 100, false FROM generate_series(1, 999) g`;
    });
    expect((await product(small.token, "LAST")).status).toBe(201); // the 1,000th
    expect((await product(small.token, "OVER")).status).toBe(409);
    const csv = await call("/v1/products/import", { method: "POST", body: "sku,name,retail_price\nCSV1,Csv one,10\n", token: small.token });
    expect(csv.status).toBe(409);
  });

  it("daily job reminds on the right days, prompts automatically once a day, and is safe to re-run", async () => {
    const calls = stubPayhero({ status: "QUEUED" });
    const a = await register("remind");
    const notes = async (token: string) => (await json<{ items?: { kind: string; title: string }[] }>(call("/v1/notifications", { token }))).items?.filter((n) => n.kind === "BILLING") ?? [];

    await endIn(a.bid, 6.5); // seven days by the count: first reminder, no prompt without a saved plan
    const first = await runBillingJob(env, sql, { businessIds: [a.bid] });
    expect(first).toMatchObject({ reminded: 1, prompted: 0, failed: 0 });
    expect(await runBillingJob(env, sql, { businessIds: [a.bid] })).toMatchObject({ reminded: 0, prompted: 0 });
    expect((await notes(a.token))[0]?.title).toContain("7 days");

    const quiet = await register("quiet");
    await endIn(quiet.bid, 5.5);
    expect(await runBillingJob(env, sql, { businessIds: [quiet.bid] })).toMatchObject({ reminded: 0, prompted: 0 });

    const auto = await register("auto");
    await send("PUT", "/v1/billing/plan", { plan: "COMMERCIAL", cycle: "ANNUAL", phone: "0712345678" }, auto.token);
    await endIn(auto.bid, 0.5); // the last day
    const before = calls.length;
    expect(await runBillingJob(env, sql, { businessIds: [auto.bid] })).toMatchObject({ reminded: 1, prompted: 1, failed: 0 });
    expect(calls.slice(before).filter((u) => u.includes("/api/v2/payments"))).toHaveLength(1);
    expect((await json(call("/v1/billing", { token: auto.token }))).payments[0]).toMatchObject({ status: "PENDING", source: "AUTO", amount_cents: "17760000", plan: "COMMERCIAL" });
    // Same day again: no second prompt.
    expect(await runBillingJob(env, sql, { businessIds: [auto.bid] })).toMatchObject({ prompted: 0 });

    const lapsed = await register("gone");
    await send("PUT", "/v1/billing/plan", { plan: "STARTER", cycle: "MONTHLY", phone: "0712345678" }, lapsed.token);
    await endIn(lapsed.bid, -3.5);
    expect(await runBillingJob(env, sql, { businessIds: [lapsed.bid] })).toMatchObject({ reminded: 1, prompted: 0 });
    await endIn(lapsed.bid, -9);
    expect(await runBillingJob(env, sql, { now: new Date(Date.now() + DAY), businessIds: [lapsed.bid] })).toMatchObject({ reminded: 0, prompted: 0 });
  });

  it("settles from a re-check when the callback is lost, and flags a wrong amount without crediting it", async () => {
    const shop = await register("lostcb");
    stubPayhero({ status: "QUEUED" });
    const pay = await json(post("/v1/billing/pay", { plan: "STARTER", cycle: "MONTHLY", phone: "0712345678" }, shop.token));
    const status = () => json(call(`/v1/billing/payments/${pay.paymentId}`, { token: shop.token }));
    expect(await status()).toMatchObject({ status: "PENDING" });
    await sql`UPDATE subscription_payments SET created_at = now() - interval '30 seconds' WHERE id = ${pay.paymentId}`;
    expect(await status()).toMatchObject({ status: "PENDING" });

    stubPayhero({ status: "SUCCESS", provider_reference: `LOST${run}`.slice(0, 12), amount: 3600 });
    expect(await status()).toMatchObject({ status: "CONFIRMED" });
    expect((await json(call("/v1/billing", { token: shop.token }))).state.kind).toBe("ACTIVE");

    const other = await register("wrongamt");
    stubPayhero({ status: "QUEUED" });
    const second = await json(post("/v1/billing/pay", { plan: "STARTER", cycle: "MONTHLY", phone: "0712345678" }, other.token));
    await sql`UPDATE subscription_payments SET created_at = now() - interval '30 seconds' WHERE id = ${second.paymentId}`;
    stubPayhero({ status: "SUCCESS", provider_reference: `WRONG${run}`.slice(0, 12), amount: 10 });
    expect(await json(call(`/v1/billing/payments/${second.paymentId}`, { token: other.token }))).toMatchObject({ status: "REVIEW" });
    expect((await json(call("/v1/billing", { token: other.token }))).state.kind).toBe("TRIAL");

    // One business can't read another's payment.
    expect((await call(`/v1/billing/payments/${second.paymentId}`, { token: shop.token })).status).toBe(404);
  });

  it("lets a platform admin set a plan by hand, and nobody else", async () => {
    const seller = (await json(post("/v1/auth/login", { email: sellerEmail, password: "correct-horse-1" }, ""))).accessToken as string;
    const shop = await register("enterprise");
    const body = { plan: "ENTERPRISE", cycle: "ANNUAL", paidUntil: "2030-01-31" };
    expect((await post(`/v1/admin/businesses/${shop.bid}/subscription`, body, shop.token)).status).toBe(403);
    expect((await post(`/v1/admin/businesses/${shop.bid}/subscription`, body, seller)).status).toBe(200);
    expect(await json(call("/v1/billing", { token: shop.token }))).toMatchObject({ plan: "ENTERPRISE", state: { kind: "ACTIVE" } });
    for (const c of ["B2", "B3", "B4", "B5", "B6", "B7"]) expect((await post("/v1/branches", { name: `Branch ${c}`, code: c }, shop.token)).status).toBe(201);
  });

  it("restricts nobody when billing isn't set up", async () => {
    const shop = await register("nobilling");
    await endIn(shop.bid, -30);
    const off = { ...env, SUPER_ADMIN_EMAILS: undefined };
    const res = await app.request("http://api.test/v1/products", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${shop.token}` }, body: JSON.stringify({ sku: "FREE1", name: "Free thing", retailPriceCents: 100, trackStock: false }) }, off);
    expect(res.status).toBe(201);
  });
});
