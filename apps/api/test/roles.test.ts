import { describe, expect, it } from "vitest";
import { app } from "../src/app";

const run = Date.now();
const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://kpos_app:app@localhost:5432/kenya_pos",
  JWT_SECRET: "test-secret-test-secret-test-secret",
  APP_ORIGIN: "http://localhost:5173",
};
const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  app.request(`http://api.test${path}`, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } }, env);
const post = (path: string, body: unknown, token: string) => call(path, { method: "POST", body: JSON.stringify(body), token });
const json = async <T = Record<string, any>>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const login = async (email: string, password: string) => (await json(post("/v1/auth/login", { email, password }, ""))).accessToken as string;

async function setup(tag: string) {
  const owner = (await json(post("/v1/auth/register", { businessName: tag, ownerName: "Owner", email: `${tag}-${run}@roles.ke`, phone: "0712345678", password: "correct-horse-1" }, ""))).accessToken as string;
  const email = `${tag}-till-${run}@roles.ke`;
  const staff = await json(post("/v1/users", { name: "Till One", email, role: "CASHIER", password: "teller-pass-1" }, owner));
  const cashier = await login(email, "teller-pass-1");
  const product = await json(post("/v1/products", { sku: "SUGAR", name: "Sugar", retailPriceCents: 10000, costCents: 7000, trackStock: false }, owner));
  const customer = await json(post("/v1/customers", { name: "Mama Duka", creditLimitCents: 1000000 }, owner));
  return { owner, cashier, staff, email, product, customer };
}

describe("cashier / teller access", () => {
  it("can sell, make quotations and invoices, and record payment", async () => {
    const { cashier, product, customer } = await setup("sells");
    const lines = [{ productId: product.id, quantity: 1 }];
    expect((await post("/v1/shifts/open", { openingFloatCents: 0 }, cashier)).status).toBe(201);
    expect((await post("/v1/documents", { type: "SALE", lines, payments: [{ method: "CASH", amountCents: 10000 }] }, cashier)).status).toBe(201);
    const quote = await json(post("/v1/documents", { type: "QUOTE", customerId: customer.id, lines }, cashier));
    expect(quote.type).toBe("QUOTE");
    const fromQuote = await post(`/v1/documents/${quote.id}/convert`, {}, cashier);
    expect(fromQuote.status).toBe(201);
    const invoice = await json(post("/v1/documents", { type: "INVOICE", customerId: customer.id, lines }, cashier));
    expect(invoice.type).toBe("INVOICE");
    expect((await post(`/v1/documents/${invoice.id}/payments`, { method: "CASH", amountCents: 10000 }, cashier)).status).toBe(201);
    expect((await post("/v1/customers", { name: "New Walk In" }, cashier)).status).toBe(201);
    for (const path of ["/v1/products", "/v1/customers", "/v1/documents", "/v1/shifts/current"]) expect((await call(path, { token: cashier })).status).toBe(200);
  });

  it("can't reach anything else", async () => {
    const { cashier, owner, product, customer } = await setup("blocked");
    for (const path of ["/v1/stock", "/v1/stock/movements", "/v1/suppliers", "/v1/purchases", "/v1/purchase-orders", "/v1/transfers", "/v1/reports/summary", "/v1/reports/pnl",
      "/v1/expenses", "/v1/users", "/v1/audit", "/v1/shifts", "/v1/notifications", "/v1/settings/payments", "/v1/settings/etims", "/v1/export/products", "/v1/reminders/overdue", "/v1/billing"])
      expect([path, (await call(path, { token: cashier })).status]).toEqual([path, 403]);

    const supplier = await json(post("/v1/suppliers", { name: "Mumias" }, owner));
    const sale = await json(post("/v1/documents", { type: "INVOICE", customerId: customer.id, lines: [{ productId: product.id, quantity: 1 }] }, owner));
    await post(`/v1/documents/${sale.id}/payments`, { method: "BANK", amountCents: 10000, reference: "EFT-ROLE" }, owner);
    const writes: [string, unknown][] = [
      ["/v1/products", { sku: "NEW", name: "New thing", retailPriceCents: 100 }],
      ["/v1/users", { name: "Sneaky", email: `sneaky-${run}@roles.ke`, role: "MANAGER", password: "correct-horse-1" }],
      ["/v1/branches", { name: "Second", code: "TWO" }],
      ["/v1/expenses", { category: "Rent", amountCents: 100, expenseDate: "2026-11-01" }],
      [`/v1/suppliers/${supplier.id}/payments`, { method: "CASH", amountCents: 100 }],
      [`/v1/documents/${sale.id}/return`, { reason: "Changed mind" }],
      ["/v1/stock/adjustments", { productId: product.id, quantity: -1, reason: "Damaged" }],
    ];
    for (const [path, body] of writes) expect([path, (await post(path, body, cashier)).status]).toEqual([path, 403]);
  });

  it("never receives cost prices; the owner still does", async () => {
    const { cashier, owner, product, customer } = await setup("margins");
    const invoice = await json(post("/v1/documents", { type: "INVOICE", customerId: customer.id, lines: [{ productId: product.id, quantity: 1 }] }, cashier));
    const seen = await json<{ cost_cents?: string }[]>(call("/v1/products", { token: cashier }));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).not.toHaveProperty("cost_cents");
    const doc = await json(call(`/v1/documents/${invoice.id}`, { token: cashier }));
    expect(doc.lines[0]).not.toHaveProperty("unit_cost_cents");
    expect(doc.lines[0]).toMatchObject({ description: "Sugar" });

    expect((await json<{ cost_cents: string }[]>(call("/v1/products", { token: owner })))[0]!.cost_cents).toBe("7000");
    expect((await json(call(`/v1/documents/${invoice.id}`, { token: owner }))).lines[0]).toHaveProperty("unit_cost_cents");
  });

  it("the owner can reset a teller's password; a teller can't reset anyone's", async () => {
    const { owner, cashier, staff, email } = await setup("reset");
    const patch = (id: string, body: unknown, token: string) => call(`/v1/users/${id}`, { method: "PATCH", body: JSON.stringify(body), token });
    const session = await json(post("/v1/auth/login", { email, password: "teller-pass-1" }, ""));
    expect((await patch(staff.id, { password: "too-short" }, owner)).status).toBe(400);
    expect((await patch(staff.id, { password: "teller-pass-2-new" }, cashier)).status).toBe(403);

    const res = await patch(staff.id, { password: "teller-pass-2-new" }, owner);
    expect(res.status).toBe(200);
    expect(await json(res)).not.toHaveProperty("password_hash");
    expect((await post("/v1/auth/login", { email, password: "teller-pass-1" }, "")).status).toBe(401);
    expect((await post("/v1/auth/login", { email, password: "teller-pass-2-new" }, "")).status).toBe(200);
    // The old session can't be renewed, and the role is untouched.
    expect((await post("/v1/auth/refresh", { refreshToken: session.refreshToken }, "")).status).toBe(401);
    expect((await json<{ id: string; role: string }[]>(call("/v1/users", { token: owner }))).find((u) => u.id === staff.id)?.role).toBe("CASHIER");
  });

  it("accountants and managers keep the back office", async () => {
    const { owner } = await setup("others");
    const user = async (role: string) => {
      const email = `${role.toLowerCase()}-${run}@roles.ke`;
      await post("/v1/users", { name: role, email, role, password: "correct-horse-1" }, owner);
      return login(email, "correct-horse-1");
    };
    for (const token of [await user("ACCOUNTANT"), await user("MANAGER")]) {
      for (const path of ["/v1/stock", "/v1/reports/summary", "/v1/reminders/overdue", "/v1/expenses"]) expect([path, (await call(path, { token })).status]).toEqual([path, 200]);
      expect((await call("/v1/users", { token })).status).toBe(403);
    }
  });
});
