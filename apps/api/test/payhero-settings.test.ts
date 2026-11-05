import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";

const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://kpos_app:app@localhost:5432/kenya_pos",
  JWT_SECRET: "test-secret-test-secret-test-secret",
  APP_ORIGIN: "http://localhost:5173",
  ENCRYPTION_KEY: "test-encryption-key",
};
const run = Date.now();
const TOKEN = "cGgtdXNlcjpwaC1zZWNyZXQ=";
const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  app.request(`http://api.test${path}`, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } }, env);
const send = (method: string, path: string, body: unknown, token: string) => call(path, { method, body: JSON.stringify(body), token });
const json = async <T = Record<string, any>>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const register = async (name: string) =>
  (await json(send("POST", "/v1/auth/register", { businessName: name, ownerName: "Owner", email: `${name}-${run}@ph.ke`, phone: "0712345678", password: "correct-horse-1" }, ""))).accessToken as string;

/** A stand-in PayHero that only accepts the right token, and records what it was sent. */
const payhero = (opts: { balance?: number; active?: boolean; down?: boolean } = {}) => {
  const calls: { url: string; auth: string | null; body: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ url: String(url), auth, body: init.body ? JSON.parse(String(init.body)) : null });
    if (opts.down) throw new Error("down");
    if (auth !== `Basic ${TOKEN}`) return new Response(JSON.stringify({ error_message: "Unauthorized" }), { status: 401 });
    if (String(url).includes("/payment_channels")) return new Response(JSON.stringify({ payment_channels: [{ id: 11386, description: "My Till", short_code: "522522", is_active: opts.active ?? true }], pagination: { next_page: null } }));
    if (String(url).includes("/wallets")) return new Response(JSON.stringify({ available_balance: opts.balance ?? 150.5 }));
    return new Response(JSON.stringify({ success: true, status: "QUEUED", reference: "E8UWT7CLUW" }), { status: 201 });
  }));
  return calls;
};

afterEach(() => vi.unstubAllGlobals());

describe("PayHero settings", () => {
  it("saves a pasted token only after PayHero accepts it and the channel is on the account", async () => {
    const t = await register("phtoken");
    const put = (token: string, channelId = 11386) => send("PUT", "/v1/settings/payments", { token, channelId }, t);

    expect((await put("user:password")).status).toBe(400);

    payhero();
    const wrong = await put("d3JvbmctdG9rZW4=");
    expect(wrong.status).toBe(422);
    expect((await wrong.json() as { error: string }).error).toMatch(/rejected this token/);
    const noChannel = await put(TOKEN, 999);
    expect(noChannel.status).toBe(422);
    expect((await noChannel.json() as { error: string }).error).toMatch(/Your channels: 11386 \(My Till\)/);
    payhero({ active: false });
    expect((await put(TOKEN)).status).toBe(422);
    payhero({ down: true });
    expect((await put(TOKEN)).status).toBe(503);
    // None of those replaced anything.
    expect(await json(call("/v1/settings/payments", { token: t }))).toEqual({ configured: false });

    payhero();
    // A pasted "Basic " prefix is dropped.
    expect(await json(put(`Basic ${TOKEN}`))).toEqual({ configured: true, verified: true, channel: { id: 11386, description: "My Till", shortCode: "522522" }, walletBalanceCents: 15050 });
    const saved = await json(call("/v1/settings/payments", { token: t }));
    expect(saved).toMatchObject({ configured: true, username: null, channelId: 11386 });
    expect(JSON.stringify(saved)).not.toContain(TOKEN);

    expect(await json(send("POST", "/v1/settings/payments/test", {}, t))).toMatchObject({ ok: true, channel: { id: 11386 }, walletBalanceCents: 15050 });
    payhero({ down: true });
    expect(await json(send("POST", "/v1/settings/payments/test", {}, t))).toMatchObject({ ok: false, reason: "UNREACHABLE" });

    // A failed replacement leaves the working token in place.
    payhero();
    expect((await put("d3JvbmctdG9rZW4=")).status).toBe(422);
    expect(await json(send("POST", "/v1/settings/payments/test", {}, t))).toMatchObject({ ok: true });

    // The till's prompt is sent with the token as given, in PayHero's documented shape.
    const p = await json(send("POST", "/v1/products", { sku: "TEA", name: "Tea", retailPriceCents: 5000, trackStock: false }, t));
    expect((await send("POST", "/v1/shifts/open", { openingFloatCents: 0 }, t)).status).toBe(201);
    const calls = payhero();
    expect((await send("POST", "/v1/payments/till-prompts", { idempotencyKey: crypto.randomUUID(), phone: "254712345678", expectedTotalCents: 5000, lines: [{ productId: p.id, quantity: 1 }] }, t)).ok).toBe(true);
    const stk = calls.find((c) => c.url.endsWith("/api/v2/payments"))!;
    expect(stk.auth).toBe(`Basic ${TOKEN}`);
    expect(stk.body).toMatchObject({ amount: 50, phone_number: "0712345678", channel_id: 11386, provider: "m-pesa" });
  });

  it("only people who manage payment settings can test them", async () => {
    const owner = await register("phroles");
    expect((await send("POST", "/v1/settings/payments/test", {}, owner)).status).toBe(409);
    expect((await send("POST", "/v1/users", { name: "Cashier", email: `cashier-${run}@ph.ke`, password: "correct-horse-1", role: "CASHIER" }, owner)).status).toBe(201);
    const cashier = (await json(send("POST", "/v1/auth/login", { email: `cashier-${run}@ph.ke`, password: "correct-horse-1" }, ""))).accessToken as string;
    expect((await send("POST", "/v1/settings/payments/test", {}, cashier)).status).toBe(403);
  });
});
