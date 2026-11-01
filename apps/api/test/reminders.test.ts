import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import { withTenant } from "../src/db";

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
  const res = await call("/v1/auth/register", { method: "POST", body: JSON.stringify({ businessName: name, ownerName: "Owner", email: `${name}-${run}@rem.ke`, phone: "0712345678", password: "correct-horse-1" }) });
  return ((await res.json()) as { accessToken: string }).accessToken;
};

describe("payment reminders", () => {
  it("lists overdue customers and logs reminders, tenant-scoped", async () => {
    const t = await register("reminders");
    const bid = ((await (await call("/v1/me", { token: t })).json()) as { business: { id: string } }).business.id;
    const cust = (await (await post("/v1/customers", { name: "Mama Njeri", phone: "0722000111", creditLimitCents: 1_000_000 }, t)).json()) as { id: string };
    const p = (await (await post("/v1/products", { sku: "SUG", name: "Sugar 1kg", retailPriceCents: 20000, trackStock: false }, t)).json()) as { id: string };
    const inv = (await (await post("/v1/documents", { type: "INVOICE", customerId: cust.id, lines: [{ productId: p.id, quantity: 2 }] }, t)).json()) as { id: string; total_cents: string };

    expect(await (await call("/v1/reminders/overdue", { token: t })).json()).toEqual([]);
    expect((await post(`/v1/customers/${cust.id}/reminders`, { channel: "SMS" }, t)).status).toBe(409);

    const sql = postgres(env.DATABASE_URL, { max: 1 });
    await withTenant(sql, bid, (tx) => tx`UPDATE documents SET due_date = due_date - 5 WHERE id = ${inv.id}`);
    await sql.end();

    expect((await post(`/v1/customers/${cust.id}/reminders`, { channel: "EMAIL" }, t)).status).toBe(400);
    expect((await post(`/v1/customers/${cust.id}/reminders`, { channel: "WHATSAPP" }, t)).status).toBe(201);
    const [d] = (await (await call("/v1/reminders/overdue", { token: t })).json()) as Record<string, unknown>[];
    expect(d).toMatchObject({ id: cust.id, invoices: 1, overdue_cents: inv.total_cents, days_overdue: 5, reminders: 1 });
    expect(d!.last_reminded_at).toBeTruthy();

    const other = await register("reminders-b");
    expect(await (await call("/v1/reminders/overdue", { token: other })).json()).toEqual([]);
    expect((await post(`/v1/customers/${cust.id}/reminders`, { channel: "SMS" }, other)).status).toBe(404);
  });
});
