import { purchaseSchema, supplierSchema } from "@kpos/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { requireAuth, requirePermission } from "../auth";
import { audit, withTenant } from "../db";
import type { AppEnv } from "../env";
import { nextNumber } from "./documents";
import { postMovement, resolveBranch } from "./stock";

export const supplierRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/suppliers", requirePermission("stock.view"), async (c) =>
    c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`SELECT * FROM suppliers ORDER BY lower(name) LIMIT 500`)))
  .post("/suppliers", requirePermission("stock.adjust"), zValidator("json", supplierSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const b = c.req.valid("json");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const [s] = await tx`INSERT INTO suppliers (business_id, name, phone, email, kra_pin) VALUES (${bid}, ${b.name}, ${b.phone ?? null}, ${b.email ?? null}, ${b.kraPin ?? null}) RETURNING *`;
      await audit(tx, { businessId: bid, userId: sub, action: "supplier.create", entity: "supplier", entityId: s!.id, after: b });
      return s;
    }), 201);
  })
  .get("/purchases", requirePermission("stock.view"), async (c) =>
    c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`
      SELECT pu.*, s.name AS supplier_name FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id ORDER BY pu.created_at DESC LIMIT 200`)))
  .post("/purchases", requirePermission("stock.adjust.approve"), zValidator("json", purchaseSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const b = c.req.valid("json");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const branchId = await resolveBranch(tx, sub, b.branchId);
      const total = b.lines.reduce((s, l) => s + Math.round(l.quantity * l.unitCostCents), 0);
      const [pu] = await tx`INSERT INTO purchases (business_id, branch_id, supplier_id, number, supplier_ref, total_cents, created_by)
        VALUES (${bid}, ${branchId}, ${b.supplierId}, ${await nextNumber(tx, bid, "PURCHASE")}, ${b.supplierRef ?? null}, ${total}, ${sub}) RETURNING *`;
      for (const l of b.lines) {
        await tx`INSERT INTO purchase_lines (business_id, purchase_id, product_id, quantity, unit_cost_cents) VALUES (${bid}, ${pu!.id}, ${l.productId}, ${l.quantity}, ${l.unitCostCents})`;
        await postMovement(tx, { businessId: bid, branchId, productId: l.productId, type: "PURCHASE", quantity: l.quantity, unitCostCents: l.unitCostCents, refType: "purchase", refId: pu!.id, userId: sub });
      }
      await audit(tx, { businessId: bid, userId: sub, action: "purchase.receive", entity: "purchase", entityId: pu!.id, after: b });
      return pu;
    }), 201);
  });
