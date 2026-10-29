import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { app } from "../src/app";

const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://kpos_app:app@localhost:5432/kenya_pos",
  JWT_SECRET: "test-secret-test-secret-test-secret",
  APP_ORIGIN: "http://localhost:5173",
};
const call = (path: string, init: RequestInit = {}, token?: string) =>
  app.request(path, { ...init, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } }, env);
const run = Date.now();
const register = async (name: string) => {
  const res = await call("/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ businessName: name, ownerName: "Owner " + name, email: `${name}-${run}@test.ke`, phone: "0712345678", password: "correct-horse-1" }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { accessToken: string; refreshToken: string };
};
const raw = postgres(env.DATABASE_URL, { max: 1 });
afterAll(() => raw.end());

describe("tenant isolation", () => {
  it("each business sees only its own users, branches and audit log", async () => {
    const a = await register("alpha");
    const b = await register("beta");
    await call("/v1/users", { method: "POST", body: JSON.stringify({ name: "Cashier A", email: `cashier-a-${run}@test.ke`, role: "CASHIER", password: "cashier-pass-1" }) }, a.accessToken);
    const usersA = (await (await call("/v1/users", {}, a.accessToken)).json()) as { email: string }[];
    const usersB = (await (await call("/v1/users", {}, b.accessToken)).json()) as { email: string }[];
    expect(usersA.map((u) => u.email)).toContain(`cashier-a-${run}@test.ke`);
    expect(usersB).toHaveLength(1);
    expect(usersB[0]!.email).toBe(`beta-${run}@test.ke`);
    const me = (await (await call("/v1/me", {}, b.accessToken)).json()) as { business: { name: string } };
    expect(me.business.name).toBe("beta");
  });

  it("the app role sees nothing without a tenant context", async () => {
    const rows = await raw`SELECT count(*)::int AS n FROM users`;
    expect(rows[0]!.n).toBe(0);
  });

  it("cashiers cannot manage users", async () => {
    const res = await call("/v1/auth/login", { method: "POST", body: JSON.stringify({ email: `cashier-a-${run}@test.ke`, password: "cashier-pass-1" }) });
    const { accessToken } = (await res.json()) as { accessToken: string };
    expect((await call("/v1/users", {}, accessToken)).status).toBe(403);
  });

  it("locks the account after 5 failed logins and rotates refresh tokens", async () => {
    const t = await register("gamma");
    const refreshed = await call("/v1/auth/refresh", { method: "POST", body: JSON.stringify({ refreshToken: t.refreshToken }) });
    expect(refreshed.status).toBe(200);
    const reuse = await call("/v1/auth/refresh", { method: "POST", body: JSON.stringify({ refreshToken: t.refreshToken }) });
    expect(reuse.status).toBe(401);
    for (let i = 0; i < 5; i++) {
      await call("/v1/auth/login", { method: "POST", body: JSON.stringify({ email: `gamma-${run}@test.ke`, password: "wrong" }) });
    }
    const locked = await call("/v1/auth/login", { method: "POST", body: JSON.stringify({ email: `gamma-${run}@test.ke`, password: "correct-horse-1" }) });
    expect(locked.status).toBe(423);
  });
});
