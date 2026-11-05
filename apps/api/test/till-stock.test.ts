import { describe, expect, it } from "vitest";
import { app } from "../src/app";

const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://kpos_app:app@localhost:5432/kenya_pos",
  JWT_SECRET: "test-secret-test-secret-test-secret",
  APP_ORIGIN: "http://localhost:5173",
};
const run = Date.now();
const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  app.request(`http://api.test${path}`, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } }, env);
const post = (path: string, body: unknown, token = "") => call(path, { method: "POST", body: JSON.stringify(body), token });
const json = async <T = Record<string, any>>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const register = async (name: string) =>
  (await json(post("/v1/auth/register", { businessName: name, ownerName: "Owner", email: `${name}-${run}@st.ke`, phone: "0712345678", password: "correct-horse-1" }))).accessToken as string;
type TillStock = { enforced: boolean; items: { product_id: string; on_hand: string }[] };

describe("till stock", () => {
  it("gives tellers on-hand for tracked products, including ones never stocked", async () => {
    const t = await register("tillstock");
    const stocked = await json(post("/v1/products", { sku: "TEA", name: "Tea", retailPriceCents: 5000 }, t));
    const empty = await json(post("/v1/products", { sku: "NONE", name: "Never stocked", retailPriceCents: 100 }, t));
    const service = await json(post("/v1/products", { sku: "SVC", name: "Delivery", retailPriceCents: 20000, trackStock: false }, t));
    await post("/v1/stock/opening", { lines: [{ productId: stocked.id, quantity: 3, unitCostCents: 1000 }] }, t);

    const email = `teller-${run}@st.ke`;
    expect((await post("/v1/users", { name: "Teller", email, password: "correct-horse-1", role: "CASHIER" }, t)).status).toBe(201);
    const teller = (await json(post("/v1/auth/login", { email, password: "correct-horse-1" }))).accessToken as string;
    // Tellers can't open the stock list, but the till still needs these counts.
    expect((await call("/v1/stock", { token: teller })).status).toBe(403);
    const seen = await json<TillStock>(call("/v1/till/stock", { token: teller }));
    expect(seen.enforced).toBe(true);
    const have = Object.fromEntries(seen.items.map((i) => [i.product_id, Number(i.on_hand)]));
    expect(have[stocked.id]).toBe(3);
    expect(have[empty.id]).toBe(0);
    expect(have[service.id]).toBeUndefined();
    expect(Object.keys(seen.items[0]!).sort()).toEqual(["on_hand", "product_id"]);

    expect((await json<TillStock>(call("/v1/till/stock", { token: await register("tillstock-b") }))).items).toEqual([]);
    expect((await call("/v1/till/stock")).status).toBe(401);
  });
});
