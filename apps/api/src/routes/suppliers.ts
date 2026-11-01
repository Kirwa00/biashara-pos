import { purchaseSchema, supplierPaymentSchema, supplierSchema } from "@kpos/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth, requirePermission } from "../auth";
import { audit, withTenant } from "../db";
import type { AppEnv } from "../env";
import { nextNumber } from "./documents";
import { postMovement, resolveBranch } from "./stock";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const supplierRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/suppliers", requirePermission("stock.view"), async (c) =>
    c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`
      SELECT s.*, coalesce(pu.t, 0) - coalesce(pay.t, 0) AS balance_cents FROM suppliers s
      LEFT JOIN (SELECT supplier_id, sum(total_cents) AS t FROM purchases GROUP BY 1) pu ON pu.supplier_id = s.id
      LEFT JOIN (SELECT supplier_id, sum(amount_cents) AS t FROM supplier_payments GROUP BY 1) pay ON pay.supplier_id = s.id
      ORDER BY lower(s.name) LIMIT 500`)))
  .post("/suppliers", requirePermission("stock.adjust"), zValidator("json", supplierSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const b = c.req.valid("json");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const [s] = await tx`INSERT INTO suppliers (business_id, name, phone, email, kra_pin) VALUES (${bid}, ${b.name}, ${b.phone ?? null}, ${b.email ?? null}, ${b.kraPin ?? null}) RETURNING *`;
      await audit(tx, { businessId: bid, userId: sub, action: "supplier.create", entity: "supplier", entityId: s!.id, after: b });
      return s;
    }), 201);
  })
  .get("/supplier-payments", requirePermission("stock.view"), async (c) =>
    c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`
      SELECT sp.*, s.name AS supplier_name FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id ORDER BY sp.created_at DESC LIMIT 100`)))
  .post("/suppliers/:id/payments", requirePermission("invoices.manage"), zValidator("json", supplierPaymentSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const id = c.req.param("id");
    const b = c.req.valid("json");
    if (!UUID.test(id)) throw new HTTPException(404, { message: "Supplier not found" });
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      // Row lock serialises payments to one supplier so two can't both pass the balance check.
      if (!(await tx`SELECT 1 FROM suppliers WHERE id = ${id} FOR UPDATE`).length) throw new HTTPException(404, { message: "Supplier not found" });
      const [{ owed }] = (await tx`SELECT (SELECT coalesce(sum(total_cents), 0) FROM purchases WHERE supplier_id = ${id})
        - (SELECT coalesce(sum(amount_cents), 0) FROM supplier_payments WHERE supplier_id = ${id}) AS owed`) as unknown as [{ owed: string }];
      if (b.amountCents > Number(owed)) throw new HTTPException(409, { message: `Only ${Number(owed) / 100} is owed to this supplier` });
      const [p] = await tx`INSERT INTO supplier_payments (business_id, supplier_id, amount_cents, method, reference, note, created_by)
        VALUES (${bid}, ${id}, ${b.amountCents}, ${b.method}, ${b.reference ?? null}, ${b.note ?? null}, ${sub}) RETURNING *`;
      await audit(tx, { businessId: bid, userId: sub, action: "supplier.pay", entity: "supplier_payment", entityId: p!.id, after: b });
      return p;
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
