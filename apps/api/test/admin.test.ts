import { describe, expect, it } from "vitest";
import { app } from "../src/app";

const run = Date.now();
const adminEmail = `admin-${run}@platform.ke`;
const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://kpos_app:app@localhost:5432/kenya_pos",
  JWT_SECRET: "test-secret-test-secret-test-secret",
  APP_ORIGIN: "http://localhost:5173",
  SUPER_ADMIN_EMAILS: `someone-else@platform.ke, ${adminEmail.toUpperCase()}`,
};
const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  app.request(`http://api.test${path}`, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } }, env);
const post = (path: string, body: unknown, token = "") => call(path, { method: "POST", body: JSON.stringify(body), token });
const json = async <T = Record<string, any>>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const register = async (name: string, email: string) =>
  json(post("/v1/auth/register", { businessName: name, ownerName: "Owner", email, phone: "0712345678", password: "correct-horse-1" }));

describe("super-admin console", () => {
  it("lists tenants, opens read-only support views, and suspends with an audit trail", async () => {
    const admin = (await register("platform", adminEmail)).accessToken as string;
    const shopEmail = `shop-${run}@shop.ke`;
    const shop = await register("Mama Shop", shopEmail);
    const shopMe = await json(call("/v1/me", { token: shop.accessToken }));
    const bid = shopMe.business.id as string;
    expect(shopMe).toMatchObject({ isSuperAdmin: false, supportSession: false });
    expect(await json(call("/v1/me", { token: admin }))).toMatchObject({ isSuperAdmin: true });
    await post("/v1/products", { sku: "TEA", name: "Tea 250g", retailPriceCents: 15000, trackStock: false }, shop.accessToken);

    expect((await call("/v1/admin/businesses", { token: shop.accessToken })).status).toBe(403);
    expect((await call("/v1/admin/businesses")).status).toBe(401);
    const list = await json<{ id: string; name: string; owner_email: string; status: string; users: number }[]>(call("/v1/admin/businesses", { token: admin }));
    expect(list.find((b) => b.id === bid)).toMatchObject({ name: "Mama Shop", owner_email: shopEmail, status: "TRIAL", users: 1 });

    // Support view: sees the shop's data, can't change anything or export it, and can't use admin routes.
    const imp = await json(post(`/v1/admin/businesses/${bid}/impersonate`, {}, admin));
    expect(imp).toMatchObject({ business: "Mama Shop", readOnly: true });
    expect(imp.refreshToken).toBeUndefined();
    expect(await json(call("/v1/me", { token: imp.accessToken }))).toMatchObject({ business: { id: bid }, supportSession: true, isSuperAdmin: false });
    expect((await json<{ sku: string }[]>(call("/v1/products", { token: imp.accessToken }))).map((p) => p.sku)).toContain("TEA");
    expect((await post("/v1/products", { sku: "X", name: "Hack", retailPriceCents: 1 }, imp.accessToken)).status).toBe(403);
    expect((await call("/v1/export/products", { token: imp.accessToken })).status).toBe(403);
    expect((await call("/v1/admin/businesses", { token: imp.accessToken })).status).toBe(403);
    const shopAudit = await json<{ action: string }[]>(call("/v1/audit", { token: shop.accessToken }));
    expect(shopAudit.some((a) => a.action === "admin.impersonate")).toBe(true);

    // Suspend: sign-in and refresh refused; reactivate restores access.
    expect((await post(`/v1/admin/businesses/${bid}/suspend`, {}, shop.accessToken)).status).toBe(403);
    const adminBid = (await json(call("/v1/me", { token: admin }))).business.id;
    expect((await post(`/v1/admin/businesses/${adminBid}/suspend`, {}, admin)).status).toBe(409);
    expect(await json(post(`/v1/admin/businesses/${bid}/suspend`, {}, admin))).toEqual({ id: bid, status: "SUSPENDED" });
    expect((await post(`/v1/admin/businesses/${bid}/suspend`, {}, admin)).status).toBe(409);
    const blocked = await post("/v1/auth/login", { email: shopEmail, password: "correct-horse-1" });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: string }).error).toMatch(/suspended/);
    expect((await post("/v1/auth/refresh", { refreshToken: shop.refreshToken })).status).toBe(401);

    expect(await json(post(`/v1/admin/businesses/${bid}/reactivate`, {}, admin))).toEqual({ id: bid, status: "ACTIVE" });
    expect((await post(`/v1/admin/businesses/${bid}/reactivate`, {}, admin)).status).toBe(409);
    expect((await post("/v1/auth/login", { email: shopEmail, password: "correct-horse-1" })).status).toBe(200);

    const actions = await json<{ action: string; business_id: string; admin_email: string }[]>(call("/v1/admin/actions", { token: admin }));
    expect(actions.filter((a) => a.business_id === bid).map((a) => a.action)).toEqual(["reactivate", "suspend", "impersonate"]);
    expect(actions[0]!.admin_email).toBe(adminEmail);
    expect((await post("/v1/admin/businesses/not-a-uuid/suspend", {}, admin)).status).toBe(404);
  });

  it("is off when SUPER_ADMIN_EMAILS is unset", async () => {
    const t = (await register("no-admins", `noadmin-${run}@platform.ke`)).accessToken as string;
    const res = await app.request("http://api.test/v1/admin/businesses", { headers: { authorization: `Bearer ${t}` } }, { ...env, SUPER_ADMIN_EMAILS: undefined });
    expect(res.status).toBe(403);
  });
});
