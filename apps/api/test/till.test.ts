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
const post = (path: string, body: unknown, token = "") => call(path, { method: "POST", body: JSON.stringify(body), token });
const patch = (id: string, body: unknown, token: string) => call(`/v1/users/${id}`, { method: "PATCH", body: JSON.stringify(body), token });
const json = async <T = Record<string, any>>(r: Response | Promise<Response>) => (await (await r).json()) as T;

async function shop(tag: string) {
  const owner = (await json(post("/v1/auth/register", { businessName: tag, ownerName: "Owner", email: `${tag}-${run}@till.ke`, phone: "0712345678", password: "correct-horse-1" }))).accessToken as string;
  const code = (await json(call("/v1/me", { token: owner }))).business.shop_code as string;
  return { owner, code };
}
const signIn = (shopCode: string, username: string, pin: string) => post("/v1/auth/till", { shopCode, username, pin });

describe("till logins", () => {
  it("the owner creates a login; the teller signs in with shop code, username and PIN, and can only sell", async () => {
    const { owner, code } = await shop("mama");
    expect(code).toMatch(/^[0-9A-F]{6}$/);
    const mary = await post("/v1/users/till", { name: "Mary Wanjiku", username: "Mary", pin: "4827" }, owner);
    expect(mary.status).toBe(201);
    const body = await json(mary);
    expect(body).toMatchObject({ username: "mary", role: "CASHIER" });
    expect(JSON.stringify(body)).not.toContain("hash");

    const listed = await json<{ id: string; username: string | null; email: string | null }[]>(call("/v1/users", { token: owner }));
    expect(listed.find((u) => u.id === body.id)).toMatchObject({ username: "mary", email: null });

    // Shop code and username aren't case-sensitive, so a teller can type them either way.
    const res = await signIn(code.toLowerCase(), "MARY", "4827");
    expect(res.status).toBe(200);
    const { accessToken, refreshToken } = await json(res);
    expect((await json(call("/v1/me", { token: accessToken }))).user).toMatchObject({ role: "CASHIER", email: null });
    expect((await call("/v1/products", { token: accessToken })).status).toBe(200);
    expect((await call("/v1/reports/summary", { token: accessToken })).status).toBe(403);
    expect((await call("/v1/users", { token: accessToken })).status).toBe(403);
    expect((await post("/v1/auth/refresh", { refreshToken })).status).toBe(200);
  });

  it("only the owner can create or change till logins", async () => {
    const { owner } = await shop("owneronly");
    const made = async (role: string) => {
      const email = `${role}-${run}@till.ke`;
      await post("/v1/users", { name: role, email, role, password: "correct-horse-1" }, owner);
      return (await json(post("/v1/auth/login", { email, password: "correct-horse-1" }))).accessToken as string;
    };
    const teller = await json(post("/v1/users/till", { name: "Teller", username: "teller", pin: "4827" }, owner));
    for (const token of [await made("MANAGER"), await made("ACCOUNTANT"), await made("CASHIER")]) {
      expect((await post("/v1/users/till", { name: "Sneaky", username: "sneaky", pin: "4827" }, token)).status).toBe(403);
      expect((await patch(teller.id, { pin: "9316" }, token)).status).toBe(403);
    }
  });

  it("refuses weak PINs and bad usernames, and usernames are unique per shop only", async () => {
    const a = await shop("shopa");
    const b = await shop("shopb");
    for (const pin of ["1234", "0000", "4321", "9999", "123", "12345", "abcd"])
      expect([pin, (await post("/v1/users/till", { name: "Weak", username: "weak", pin }, a.owner)).status]).toEqual([pin, 400]);
    for (const username of ["ab", "has space", "me@shop"])
      expect([username, (await post("/v1/users/till", { name: "Bad", username, pin: "4827" }, a.owner)).status]).toEqual([username, 400]);

    expect((await post("/v1/users/till", { name: "Mary A", username: "mary", pin: "4827" }, a.owner)).status).toBe(201);
    expect((await post("/v1/users/till", { name: "Mary Again", username: "MARY", pin: "9316" }, a.owner)).status).toBe(409);
    expect((await post("/v1/users/till", { name: "Mary B", username: "mary", pin: "9316" }, b.owner)).status).toBe(201);

    // Each Mary only opens her own shop.
    expect((await signIn(a.code, "mary", "4827")).status).toBe(200);
    expect((await signIn(b.code, "mary", "9316")).status).toBe(200);
    expect((await signIn(a.code, "mary", "9316")).status).toBe(401);
    expect((await signIn(b.code, "mary", "4827")).status).toBe(401);
  });

  it("locks after five wrong PINs, gives nothing away, and the owner's new PIN unlocks it", async () => {
    const { owner, code } = await shop("lockout");
    const t = await json(post("/v1/users/till", { name: "Teller", username: "teller", pin: "4827" }, owner));
    const session = await json(signIn(code, "teller", "4827"));

    // Wrong shop, wrong name and wrong PIN all read the same.
    const messages = await Promise.all([signIn("ZZZZZZ", "teller", "4827"), signIn(code, "nobody", "4827"), signIn(code, "teller", "9316")].map((r) => json(r)));
    expect(new Set(messages.map((m) => m.error)).size).toBe(1);

    for (let i = 0; i < 4; i++) expect((await signIn(code, "teller", "9316")).status).toBe(401);
    expect((await signIn(code, "teller", "4827")).status).toBe(423); // locked, even with the right PIN

    expect((await patch(t.id, { pin: "1234" }, owner)).status).toBe(400);
    expect((await patch(t.id, { pin: "5173" }, owner)).status).toBe(200);
    expect((await signIn(code, "teller", "4827")).status).toBe(401);
    expect((await signIn(code, "teller", "5173")).status).toBe(200);
    // A new PIN ends the old session, and it's logged without the PIN.
    expect((await post("/v1/auth/refresh", { refreshToken: session.refreshToken })).status).toBe(401);
  });

  it("a till login stays a cashier, with a PIN and never a password", async () => {
    const { owner, code } = await shop("staysteller");
    const t = await json(post("/v1/users/till", { name: "Teller", username: "teller", pin: "4827" }, owner));
    expect((await patch(t.id, { role: "MANAGER" }, owner)).status).toBe(409);
    expect((await patch(t.id, { password: "correct-horse-1" }, owner)).status).toBe(409);

    const email = `withemail-${run}@till.ke`;
    const manager = await json(post("/v1/users", { name: "Manager", email, role: "MANAGER", password: "correct-horse-1" }, owner));
    expect((await patch(manager.id, { pin: "4827" }, owner)).status).toBe(409);
    expect((await signIn(code, email, "4827")).status).toBe(400);

    expect((await patch(t.id, { isActive: false }, owner)).status).toBe(200);
    expect((await signIn(code, "teller", "4827")).status).toBe(401);
  });

  it("a suspended business's tellers can't sign in", async () => {
    const adminEmail = `till-admin-${run}@till.ke`;
    const withAdmin = { ...env, SUPER_ADMIN_EMAILS: adminEmail };
    const req = (path: string, body: unknown, token = "") =>
      app.request(`http://api.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }, withAdmin);
    const admin = (await json(req("/v1/auth/register", { businessName: "platform", ownerName: "Admin", email: adminEmail, phone: "0712345678", password: "correct-horse-1" }))).accessToken as string;
    const { owner, code } = await shop("suspended");
    const bid = (await json(call("/v1/me", { token: owner }))).business.id as string;
    await post("/v1/users/till", { name: "Teller", username: "teller", pin: "4827" }, owner);
    expect((await req(`/v1/admin/businesses/${bid}/suspend`, {}, admin)).status).toBe(200);
    expect((await signIn(code, "teller", "4827")).status).toBe(403);
  });
});
