import { customerSchema, type CustomerInput } from "@kpos/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth, requirePermission } from "../auth";
import { audit, withTenant } from "../db";
import type { AppEnv } from "../env";

const row = (b: CustomerInput) => ({
  name: b.name, phone: b.phone ?? null, email: b.email ?? null, kra_pin: b.kraPin ?? null, address: b.address ?? null,
  price_tier: b.priceTier, credit_limit_cents: b.creditLimitCents, payment_terms_days: b.paymentTermsDays,
});
const COLS = Object.keys(row(customerSchema.parse({ name: "xx" }))) as (keyof ReturnType<typeof row>)[];

export const customerRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/customers", async (c) => {
    const q = c.req.query("q")?.trim().toLowerCase();
    return c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`
      SELECT * FROM customers WHERE is_active
        ${q ? tx`AND (lower(name) LIKE ${"%" + q + "%"} OR phone LIKE ${"%" + q + "%"} OR lower(kra_pin) = ${q})` : tx``}
      ORDER BY lower(name) LIMIT 200`));
  })
  .get("/customers/:id", async (c) => {
    const [cust] = await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`SELECT * FROM customers WHERE id = ${c.req.param("id")}`);
    if (!cust) throw new HTTPException(404, { message: "Customer not found" });
    return c.json(cust);
  })
  .post("/customers", requirePermission("customers.manage"), zValidator("json", customerSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const body = c.req.valid("json");
    const cust = await withTenant(c.get("sql"), bid, async (tx) => {
      const [r] = await tx`INSERT INTO customers ${tx({ ...row(body), business_id: bid }, ...COLS, "business_id")} RETURNING *`;
      await audit(tx, { businessId: bid, userId: sub, action: "customer.create", entity: "customer", entityId: r!.id, after: body });
      return r;
    });
    return c.json(cust, 201);
  })
  .put("/customers/:id", requirePermission("customers.manage"), zValidator("json", customerSchema), async (c) => {
    const { sub, bid, role } = c.get("auth");
    const body = c.req.valid("json");
    const id = c.req.param("id");
    const cust = await withTenant(c.get("sql"), bid, async (tx) => {
      const [before] = await tx`SELECT * FROM customers WHERE id = ${id} FOR UPDATE`;
      if (!before) throw new HTTPException(404, { message: "Customer not found" });
      if (role === "CASHIER" && Number(before.credit_limit_cents) !== body.creditLimitCents)
        throw new HTTPException(403, { message: "Only a manager can change credit limits" });
      const [r] = await tx`UPDATE customers SET ${tx(row(body), ...COLS)}, updated_at = now() WHERE id = ${id} RETURNING *`;
      await audit(tx, { businessId: bid, userId: sub, action: "customer.update", entity: "customer", entityId: id, before, after: body });
      return r;
    });
    return c.json(cust);
  });
