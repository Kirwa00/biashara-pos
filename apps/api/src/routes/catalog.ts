import { csvRowToProduct, parseCsv, productSchema, type ProductInput } from "@kpos/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type postgres from "postgres";
import { z } from "zod";
import { requireAuth, requirePermission } from "../auth";
import { audit, withTenant } from "../db";
import type { AppEnv } from "../env";

const MAX_IMPORT_ROWS = 5000;
const REQUIRED_HEADERS = ["sku", "name", "retail_price"];
/** CSV header -> column. On re-import only columns present in the file are updated. */
const CSV_UPDATE_COLUMNS: Record<string, string> = {
  name: "name", category: "category_id", barcode: "barcode", unit: "base_unit", tax_code: "tax_code",
  retail_price: "retail_price_cents", wholesale_price: "wholesale_price_cents", wholesale_min_qty: "wholesale_min_qty",
  cost: "cost_cents", reorder_level: "reorder_level",
};

const productRow = (p: ProductInput, businessId: string) => ({
  business_id: businessId,
  category_id: p.categoryId ?? null,
  sku: p.sku,
  barcode: p.barcode ?? null,
  name: p.name,
  base_unit: p.baseUnit,
  tax_code: p.taxCode,
  price_includes_tax: p.priceIncludesTax,
  cost_cents: p.costCents,
  retail_price_cents: p.retailPriceCents,
  wholesale_price_cents: p.wholesalePriceCents ?? null,
  wholesale_min_qty: p.wholesaleMinQty ?? null,
  reorder_level: p.reorderLevel,
  track_stock: p.trackStock,
});
const COLS = Object.keys(productRow(productSchema.parse({ sku: "x", name: "xx", retailPriceCents: 0 }), "")) as (keyof ReturnType<typeof productRow>)[];

async function replaceUnits(tx: postgres.TransactionSql, businessId: string, productId: string, units: ProductInput["units"]) {
  await tx`DELETE FROM product_units WHERE product_id = ${productId}`;
  for (const u of units) {
    await tx`INSERT INTO product_units (business_id, product_id, unit, factor, price_cents, barcode)
      VALUES (${businessId}, ${productId}, ${u.unit}, ${u.factor}, ${u.priceCents}, ${u.barcode ?? null})`;
  }
}

export const catalogRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/categories", async (c) =>
    c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`SELECT id, name FROM categories ORDER BY lower(name)`)),
  )
  .post("/categories", requirePermission("catalog.manage"), zValidator("json", z.object({ name: z.string().trim().min(2).max(60) })), async (c) => {
    const { bid } = c.get("auth");
    const [cat] = await withTenant(c.get("sql"), bid, (tx) => tx`INSERT INTO categories (business_id, name) VALUES (${bid}, ${c.req.valid("json").name}) RETURNING id, name`);
    return c.json(cat, 201);
  })
  .get("/products", async (c) => {
    const q = c.req.query("q")?.trim();
    const categoryId = c.req.query("categoryId");
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
    const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
    const rows = await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`
      SELECT p.*, cat.name AS category_name,
        COALESCE((SELECT json_agg(json_build_object('unit', u.unit, 'factor', u.factor, 'priceCents', u.price_cents, 'barcode', u.barcode)) FROM product_units u WHERE u.product_id = p.id), '[]') AS units
      FROM products p LEFT JOIN categories cat ON cat.id = p.category_id
      WHERE p.is_active
        ${q ? tx`AND (lower(p.name) LIKE ${"%" + q.toLowerCase() + "%"} OR p.sku = ${q} OR p.barcode = ${q}
              OR EXISTS (SELECT 1 FROM product_units u WHERE u.product_id = p.id AND u.barcode = ${q}))` : tx``}
        ${categoryId ? tx`AND p.category_id = ${categoryId}` : tx``}
      ORDER BY lower(p.name) LIMIT ${limit} OFFSET ${offset}`);
    return c.json(rows);
  })
  .post("/products", requirePermission("catalog.manage"), zValidator("json", productSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const body = c.req.valid("json");
    const product = await withTenant(c.get("sql"), bid, async (tx) => {
      const [p] = await tx`INSERT INTO products ${tx(productRow(body, bid), ...COLS)} RETURNING *`;
      await replaceUnits(tx, bid, p!.id, body.units);
      await audit(tx, { businessId: bid, userId: sub, action: "product.create", entity: "product", entityId: p!.id, after: body });
      return p;
    });
    return c.json(product, 201);
  })
  .put("/products/:id", requirePermission("catalog.manage"), zValidator("json", productSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const body = c.req.valid("json");
    const id = c.req.param("id");
    const product = await withTenant(c.get("sql"), bid, async (tx) => {
      const [before] = await tx`SELECT * FROM products WHERE id = ${id} FOR UPDATE`;
      if (!before) throw new HTTPException(404, { message: "Product not found" });
      const [p] = await tx`UPDATE products SET ${tx(productRow(body, bid), ...COLS)}, updated_at = now() WHERE id = ${id} RETURNING *`;
      await replaceUnits(tx, bid, id, body.units);
      await audit(tx, { businessId: bid, userId: sub, action: "product.update", entity: "product", entityId: id, before, after: body });
      return p;
    });
    return c.json(product);
  })
  .delete("/products/:id", requirePermission("catalog.manage"), async (c) => {
    const { sub, bid } = c.get("auth");
    const id = c.req.param("id");
    await withTenant(c.get("sql"), bid, async (tx) => {
      const r = await tx`UPDATE products SET is_active = false, updated_at = now() WHERE id = ${id} RETURNING id`;
      if (!r.length) throw new HTTPException(404, { message: "Product not found" });
      await audit(tx, { businessId: bid, userId: sub, action: "product.archive", entity: "product", entityId: id });
    });
    return c.body(null, 204);
  })
  /** Body: raw CSV text (sku, name, retail_price required). Upserts by SKU, updating only supplied columns; all-or-nothing, returns per-row errors when any row is invalid. */
  .post("/products/import", requirePermission("catalog.manage"), async (c) => {
    const { sub, bid } = c.get("auth");
    const rows = parseCsv(await c.req.text());
    if (!rows.length) throw new HTTPException(400, { message: "CSV has no rows" });
    if (rows.length > MAX_IMPORT_ROWS) throw new HTTPException(400, { message: `Max ${MAX_IMPORT_ROWS} rows per import` });
    const headers = Object.keys(rows[0]!);
    const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
    if (missing.length) throw new HTTPException(400, { message: `Missing columns: ${missing.join(", ")}` });
    const updateSet = headers.filter((h) => h in CSV_UPDATE_COLUMNS).map((h) => `${CSV_UPDATE_COLUMNS[h]} = excluded.${CSV_UPDATE_COLUMNS[h]}`);
    const errors: { row: number; error: string }[] = [];
    const seenSku = new Map<string, number>();
    const parsed = rows.flatMap((r, i) => {
      try {
        const { category, ...p } = csvRowToProduct(r);
        const res = productSchema.safeParse(p);
        if (!res.success) throw new Error(res.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; "));
        const firstRow = seenSku.get(res.data.sku);
        if (firstRow) throw new Error(`SKU ${res.data.sku} repeats row ${firstRow}`);
        seenSku.set(res.data.sku, i + 2);
        return [{ category, product: res.data }];
      } catch (e) {
        errors.push({ row: i + 2, error: (e as Error).message });
        return [];
      }
    });
    if (errors.length) return c.json({ imported: 0, errors }, 422);
    const imported = await withTenant(c.get("sql"), bid, async (tx) => {
      const names = [...new Set(parsed.map((p) => p.category).filter((n): n is string => !!n))];
      const catIds = new Map<string, string>();
      for (const name of names) {
        const [cat] = await tx`INSERT INTO categories (business_id, name) VALUES (${bid}, ${name})
          ON CONFLICT (business_id, lower(name)) DO UPDATE SET name = categories.name RETURNING id`;
        catIds.set(name.toLowerCase(), cat!.id);
      }
      const values = parsed.map(({ category, product }) =>
        productRow({ ...product, categoryId: category ? catIds.get(category.toLowerCase()) : undefined }, bid));
      for (let i = 0; i < values.length; i += 500) {
        await tx`INSERT INTO products ${tx(values.slice(i, i + 500), ...COLS)}
          ON CONFLICT (business_id, sku) DO UPDATE SET ${tx.unsafe([...updateSet, "is_active = true", "updated_at = now()"].join(", "))}`;
      }
      await audit(tx, { businessId: bid, userId: sub, action: "product.import", entity: "product", after: { rows: values.length } });
      return values.length;
    });
    return c.json({ imported, errors: [] });
  });
