import postgres from "postgres";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { withTenant } from "../src/db";
import { CRON_JOBS, runJob } from "../src/jobs";

const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://kpos_app:app@localhost:5432/kenya_pos",
  JWT_SECRET: "test-secret-test-secret-test-secret",
  APP_ORIGIN: "http://localhost:5173",
  RESEND_API_KEY: "re_test",
  EMAIL_FROM: "BiasharaPOS <alerts@test.ke>",
};
const run = Date.now();
const sql = postgres(env.DATABASE_URL, { max: 2 });
const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  app.request(`http://api.test${path}`, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } }, env);
const post = (path: string, body: unknown, token: string) => call(path, { method: "POST", body: JSON.stringify(body), token });
const json = async <T = Record<string, any>>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const register = async (name: string) => {
  const email = `${name}-${run}@notif.ke`;
  const t = (await json(post("/v1/auth/register", { businessName: name, ownerName: "Owner", email, phone: "0712345678", password: "correct-horse-1" }, ""))).accessToken as string;
  const bid = (await json(call("/v1/me", { token: t }))).business.id as string;
  return { t, bid, email };
};
type Sent = { to: string[]; subject: string; text: string; key: string | null };
const resend = (status = 200) => {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.resend.com/emails");
    sent.push({ ...JSON.parse(String(init.body)), key: new Headers(init.headers).get("idempotency-key") });
    return new Response("{}", { status });
  }));
  return sent;
};
type List = { unread: number; items: { id: string; kind: string; data: Record<string, any>; email_status: string; body: string }[] };

afterEach(() => vi.unstubAllGlobals());
afterAll(() => sql.end());

describe("alerts & reminders jobs", () => {
  it("are wired to the wrangler cron triggers", () => {
    const toml = readFileSync(join(import.meta.dirname, "..", "wrangler.toml"), "utf8");
    const crons = JSON.parse(/crons\s*=\s*(\[.*\])/.exec(toml)![1]!) as string[];
    expect(crons.sort()).toEqual(Object.keys(CRON_JOBS).sort());
    expect(new Set(Object.values(CRON_JOBS))).toEqual(new Set(["morning", "evening"]));
  });

  it("morning and evening runs raise each alert once, email owners once, and stay tenant-scoped", async () => {
    const { t, bid, email } = await register("alerts");
    const p = await json(post("/v1/products", { sku: "MILK", name: "Milk 500ml", retailPriceCents: 6000, reorderLevel: 5 }, t));
    await post("/v1/stock/opening", { lines: [{ productId: p.id, quantity: 4, unitCostCents: 4000 }] }, t);
    expect((await post("/v1/shifts/open", { openingFloatCents: 0 }, t)).status).toBe(201);
    const sale = await json(post("/v1/documents", { type: "SALE", lines: [{ productId: p.id, quantity: 1 }], payments: [{ method: "CASH", amountCents: 6000 }] }, t));
    expect(sale.total_cents).toBe("6000");
    const cust = await json(post("/v1/customers", { name: "Mama Njeri", phone: "0722000111", creditLimitCents: 1_000_000 }, t));
    const inv = await json(post("/v1/documents", { type: "INVOICE", customerId: cust.id, lines: [{ productId: p.id, quantity: 1 }] }, t));
    await withTenant(sql, bid, async (tx) => {
      await tx`UPDATE documents SET due_date = issue_date - 3 WHERE id = ${inv.id}`;
      await tx`INSERT INTO payments (business_id, document_id, method, amount_cents, status, phone) VALUES (${bid}, ${inv.id}, 'MPESA', 4000, 'FAILED', '254722000111')`;
    });
    const sup = await json(post("/v1/suppliers", { name: "Brookside" }, t));
    await post("/v1/purchase-orders", { supplierId: sup.id, lines: [{ productId: p.id, quantity: 10, unitCostCents: 4000 }] }, t);

    // The cron visits every non-suspended business through the definer function (RLS hides businesses otherwise).
    expect((await sql`SELECT id FROM job_business_ids()`).map((r) => r.id)).toContain(bid);

    const sent = resend();
    expect(await runJob(env, sql, "morning", { businessIds: [bid] })).toMatchObject({ created: 4, emailed: 4, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: [email], subject: "alerts: 4 alerts" });
    expect(sent[0]!.key).toMatch(/^[0-9a-f]{64}$/);
    expect(sent[0]!.text).toContain("Milk 500ml: 2 left");

    // Idempotent: a retried or overlapping run for the same day creates and sends nothing.
    expect(await runJob(env, sql, "morning", { businessIds: [bid] })).toMatchObject({ created: 0, emailed: 0 });
    expect(sent).toHaveLength(1);

    const list = await json<List>(call("/v1/notifications", { token: t }));
    expect(list.unread).toBe(4);
    const by = Object.fromEntries(list.items.map((n) => [n.kind, n]));
    expect(Object.keys(by).sort()).toEqual(["LOW_STOCK", "OVERDUE_INVOICES", "PAYMENT_ISSUES", "PO_ACTION"]);
    expect(list.items.every((n) => n.email_status === "SENT")).toBe(true);
    expect(by.LOW_STOCK!.data.count).toBe(1);
    expect(by.OVERDUE_INVOICES!.data).toMatchObject({ invoices: 1, customers: 1, overdue_cents: inv.total_cents });
    expect(by.PAYMENT_ISSUES!.data).toMatchObject({ failed: 1, failed_cents: "4000", pending: 0 });
    expect(by.PO_ACTION!.data).toMatchObject({ awaiting_approval: 1, approval_cents: "40000", awaiting_delivery: 0 });

    expect(await runJob(env, sql, "evening", { businessIds: [bid] })).toMatchObject({ created: 2, emailed: 2 });
    expect(await runJob(env, sql, "evening", { businessIds: [bid] })).toMatchObject({ created: 0, emailed: 0 });
    expect(sent).toHaveLength(2);
    const summary = (await json<List>(call("/v1/notifications?unread=1", { token: t }))).items.find((n) => n.kind === "DAILY_SUMMARY")!;
    expect(summary.data).toMatchObject({ sales: 2, gross_cents: String(6000 + Number(inv.total_cents)), received_cents: "6000", expenses_cents: "0" });
    expect(summary.data.received).toEqual([{ method: "CASH", amount_cents: "6000" }]);

    // Another tenant sees none of it and cannot mark it read.
    const other = await register("alerts-b");
    expect((await json<List>(call("/v1/notifications", { token: other.t }))).items).toEqual([]);
    expect((await post(`/v1/notifications/${summary.id}/read`, {}, other.t)).status).toBe(404);

    expect((await post(`/v1/notifications/${summary.id}/read`, {}, t)).status).toBe(200);
    expect((await json<List>(call("/v1/notifications", { token: t }))).unread).toBe(5);
    expect(await json(post("/v1/notifications/read-all", {}, t))).toEqual({ updated: 5 });
    expect((await json<List>(call("/v1/notifications?unread=1", { token: t }))).items).toEqual([]);
    expect((await post("/v1/notifications/not-a-uuid/read", {}, t)).status).toBe(404);
  });

  it("retries a failed email on the next run without duplicating the alert, and skips email when Resend is not configured", async () => {
    const a = await register("alerts-retry");
    const p = await json(post("/v1/products", { sku: "SALT", name: "Salt", retailPriceCents: 3000, reorderLevel: 2 }, a.t));
    expect(p.id).toBeTruthy();

    const down = resend(500);
    expect(await runJob(env, sql, "morning", { businessIds: [a.bid] })).toMatchObject({ created: 1, emailed: 0 });
    expect(down).toHaveLength(1);
    expect((await json<List>(call("/v1/notifications", { token: a.t }))).items[0]!.email_status).toBe("FAILED");

    const up = resend();
    expect(await runJob(env, sql, "morning", { businessIds: [a.bid] })).toMatchObject({ created: 0, emailed: 1 });
    expect(up[0]!.key).toBe(down[0]!.key);
    expect((await json<List>(call("/v1/notifications", { token: a.t }))).items.map((n) => n.email_status)).toEqual(["SENT"]);

    const b = await register("alerts-noemail");
    await post("/v1/products", { sku: "SALT", name: "Salt", retailPriceCents: 3000, reorderLevel: 2 }, b.t);
    const none = resend();
    expect(await runJob({ ...env, RESEND_API_KEY: undefined }, sql, "morning", { businessIds: [b.bid] })).toMatchObject({ created: 1, emailed: 0 });
    expect(none).toHaveLength(0);
    expect((await json<List>(call("/v1/notifications", { token: b.t }))).items[0]!.email_status).toBe("SKIPPED");

    const cashier = await json(post("/v1/users", { name: "Cashier", email: `cashier-${run}@notif.ke`, password: "correct-horse-1", role: "CASHIER" }, b.t));
    expect(cashier.id).toBeTruthy();
    const ct = (await json(post("/v1/auth/login", { email: `cashier-${run}@notif.ke`, password: "correct-horse-1" }, ""))).accessToken as string;
    expect((await call("/v1/notifications", { token: ct })).status).toBe(403);
  });
});
