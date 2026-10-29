import { describe, expect, it } from "vitest";
import { app } from "../src/app";

const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://kpos_app:app@localhost:5432/kenya_pos",
  JWT_SECRET: "test-secret-test-secret-test-secret",
  APP_ORIGIN: "http://localhost:5173",
};
const run = Date.now();
const call = (path: string, init: RequestInit & { token?: string; type?: string } = {}) =>
  app.request(path, { ...init, headers: { "content-type": init.type ?? "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } }, env);
const register = async (name: string) => {
  const res = await call("/v1/auth/register", { method: "POST", body: JSON.stringify({ businessName: name, ownerName: "Owner", email: `${name}-${run}@cat.ke`, phone: "0712345678", password: "correct-horse-1" }) });
  return ((await res.json()) as { accessToken: string }).accessToken;
};

describe("catalog", () => {
  it("imports 500 products from CSV, upserts by SKU, and keeps them per business", async () => {
    const a = await register("shop-a");
    const b = await register("shop-b");
    const csv = ["sku,name,category,barcode,unit,tax_code,retail_price,wholesale_price,wholesale_min_qty,cost,reorder_level"]
      .concat(Array.from({ length: 500 }, (_, i) => `SKU-${i},"Item ${i}, 1kg",${i % 2 ? "Dairy" : "Dry Goods"},6161${String(i).padStart(9, "0")},pc,B,${100 + i},${90 + i},12,70,5`))
      .join("\n");
    const res = await call("/v1/products/import", { method: "POST", body: csv, token: a, type: "text/csv" });
    expect(await res.json()).toEqual({ imported: 500, errors: [] });
    const again = await call("/v1/products/import", { method: "POST", body: "sku,name,retail_price\nSKU-0,Renamed item,150", token: a, type: "text/csv" });
    expect(again.status).toBe(200);

    const list = (await (await call("/v1/products?limit=500", { token: a })).json()) as unknown[];
    expect(list).toHaveLength(500);
    const [renamed] = (await (await call("/v1/products?q=SKU-0", { token: a })).json()) as { name: string; retail_price_cents: string }[];
    expect(renamed).toMatchObject({ name: "Renamed item", retail_price_cents: "15000" });
    const cats = (await (await call("/v1/categories", { token: a })).json()) as unknown[];
    expect(cats).toHaveLength(2);
    expect(await (await call("/v1/products", { token: b })).json()).toEqual([]);
  });

  it("reports row errors without importing anything", async () => {
    const t = await register("shop-c");
    const res = await call("/v1/products/import", { method: "POST", body: "sku,name,retail_price,tax_code\nA1,Good row,10,B\nA2,Bad row,10,Z", token: t, type: "text/csv" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { errors: { row: number }[] }).errors[0]!.row).toBe(3);
    expect(await (await call("/v1/products", { token: t })).json()).toEqual([]);
  });

  it("creates a product with a carton unit, finds it by unit barcode, rejects duplicate SKU", async () => {
    const t = await register("shop-d");
    const body = { sku: "MLK", name: "Milk 500ml", retailPriceCents: 6500, units: [{ unit: "crate", factor: 24, priceCents: 140000, barcode: "999000" }] };
    expect((await call("/v1/products", { method: "POST", body: JSON.stringify(body), token: t })).status).toBe(201);
    const found = (await (await call("/v1/products?q=999000", { token: t })).json()) as { sku: string; units: { factor: number }[] }[];
    expect(found[0]!.sku).toBe("MLK");
    expect(found[0]!.units[0]!.factor).toBe(24);
    expect((await call("/v1/products", { method: "POST", body: JSON.stringify(body), token: t })).status).toBe(409);
  });
});

describe("customers", () => {
  it("creates, searches and validates KRA PIN; cashier cannot change credit limits", async () => {
    const t = await register("shop-e");
    const bad = await call("/v1/customers", { method: "POST", body: JSON.stringify({ name: "Bad Pin", kraPin: "123" }), token: t });
    expect(bad.status).toBe(400);
    const res = await call("/v1/customers", { method: "POST", body: JSON.stringify({ name: "Wanjiku Stores", phone: "0722000111", kraPin: "P051234567X", priceTier: "WHOLESALE", creditLimitCents: 5000000, paymentTermsDays: 30 }), token: t });
    const cust = (await res.json()) as { id: string };
    expect(res.status).toBe(201);
    const found = (await (await call("/v1/customers?q=wanjiku", { token: t })).json()) as unknown[];
    expect(found).toHaveLength(1);

    await call("/v1/users", { method: "POST", body: JSON.stringify({ name: "Till One", email: `till-${run}@cat.ke`, role: "CASHIER", password: "cashier-pass-1" }), token: t });
    const login = await call("/v1/auth/login", { method: "POST", body: JSON.stringify({ email: `till-${run}@cat.ke`, password: "cashier-pass-1" }) });
    const cashier = ((await login.json()) as { accessToken: string }).accessToken;
    const upd = await call(`/v1/customers/${cust.id}`, { method: "PUT", body: JSON.stringify({ name: "Wanjiku Stores", creditLimitCents: 9900000 }), token: cashier });
    expect(upd.status).toBe(403);
  });
});
