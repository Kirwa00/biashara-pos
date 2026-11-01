import { can, purchaseOrderSchema, purchaseSchema, receiveOrderSchema, supplierPaymentSchema, supplierSchema } from "@kpos/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth, requirePermission } from "../auth";
import { audit, withTenant } from "../db";
import type { AppEnv } from "../env";
import { nextNumber } from "./documents";
import { postMovement, resolveBranch } from "./stock";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Tx = Parameters<typeof postMovement>[0];
type GoodsLine = { productId: string; quantity: number; unitCostCents: number; totalCents?: number };

/** Posts a GRN: the purchase, its lines and the stock movements. */
async function receiveGoods(tx: Tx, a: { bid: string; sub: string; branchId: string; supplierId: string; supplierRef?: string; purchaseOrderId?: string; lines: GoodsLine[] }) {
  const total = a.lines.reduce((s, l) => s + (l.totalCents ?? Math.round(l.quantity * l.unitCostCents)), 0);
  const [pu] = await tx`INSERT INTO purchases (business_id, branch_id, supplier_id, number, supplier_ref, total_cents, created_by, purchase_order_id)
    VALUES (${a.bid}, ${a.branchId}, ${a.supplierId}, ${await nextNumber(tx, a.bid, "PURCHASE")}, ${a.supplierRef ?? null}, ${total}, ${a.sub}, ${a.purchaseOrderId ?? null}) RETURNING *`;
  for (const l of a.lines) {
    await tx`INSERT INTO purchase_lines (business_id, purchase_id, product_id, quantity, unit_cost_cents) VALUES (${a.bid}, ${pu!.id}, ${l.productId}, ${l.quantity}, ${l.unitCostCents})`;
    await postMovement(tx, { businessId: a.bid, branchId: a.branchId, productId: l.productId, type: "PURCHASE", quantity: l.quantity, unitCostCents: l.unitCostCents, refType: "purchase", refId: pu!.id, userId: a.sub });
  }
  return pu!;
}

const notFound = () => new HTTPException(404, { message: "Purchase order not found" });

export const supplierRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  // Balances are finance data: only roles with reports.view see them; cashiers just get the supplier list.
  .get("/suppliers", requirePermission("stock.view"), async (c) =>
    c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => !can(c.get("auth").role, "reports.view")
      ? tx`SELECT * FROM suppliers ORDER BY lower(name) LIMIT 500`
      : tx`
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
  .get("/supplier-payments", requirePermission("reports.view"), async (c) =>
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
      const pu = await receiveGoods(tx, { bid, sub, branchId, supplierId: b.supplierId, supplierRef: b.supplierRef, lines: b.lines });
      await audit(tx, { businessId: bid, userId: sub, action: "purchase.receive", entity: "purchase", entityId: pu.id, after: b });
      return pu;
    }), 201);
  })
  .get("/purchase-orders", requirePermission("reports.view"), async (c) =>
    c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`
      SELECT po.*, s.name AS supplier_name,
        CASE WHEN po.status IN ('APPROVED', 'PARTIAL') THEN (SELECT coalesce(round(sum((l.quantity_ordered - l.quantity_received) * l.unit_cost_cents)), 0)
          FROM purchase_order_lines l WHERE l.purchase_order_id = po.id) ELSE 0 END AS outstanding_cents
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id ORDER BY po.created_at DESC LIMIT 200`)))
  .get("/purchase-orders/:id", requirePermission("reports.view"), async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) throw notFound();
    return c.json(await withTenant(c.get("sql"), c.get("auth").bid, async (tx) => {
      const [po] = await tx`SELECT po.*, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ${id}`;
      if (!po) throw notFound();
      const lines = await tx`SELECT l.*, p.name AS product_name, p.sku FROM purchase_order_lines l JOIN products p ON p.id = l.product_id WHERE l.purchase_order_id = ${id} ORDER BY l.id`;
      return { ...po, lines };
    }));
  })
  .post("/purchase-orders", requirePermission("stock.adjust"), zValidator("json", purchaseOrderSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const b = c.req.valid("json");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const branchId = await resolveBranch(tx, sub, b.branchId);
      const total = b.lines.reduce((s, l) => s + Math.round(l.quantity * l.unitCostCents), 0);
      const [po] = await tx`INSERT INTO purchase_orders (business_id, branch_id, supplier_id, number, note, total_cents, created_by)
        VALUES (${bid}, ${branchId}, ${b.supplierId}, ${await nextNumber(tx, bid, "PO")}, ${b.note ?? null}, ${total}, ${sub}) RETURNING *`;
      for (const l of b.lines)
        await tx`INSERT INTO purchase_order_lines (business_id, purchase_order_id, product_id, quantity_ordered, unit_cost_cents)
          VALUES (${bid}, ${po!.id}, ${l.productId}, ${l.quantity}, ${l.unitCostCents})`;
      await audit(tx, { businessId: bid, userId: sub, action: "po.create", entity: "purchase_order", entityId: po!.id, after: b });
      return po;
    }), 201);
  })
  .post("/purchase-orders/:id/:action{approve|cancel}", requirePermission("stock.adjust.approve"), async (c) => {
    const { sub, bid } = c.get("auth");
    const { id, action } = c.req.param();
    if (!UUID.test(id)) throw notFound();
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const [po] = action === "approve"
        ? await tx`UPDATE purchase_orders SET status = 'APPROVED', approved_by = ${sub}, approved_at = now() WHERE id = ${id} AND status = 'PENDING' RETURNING *`
        : await tx`UPDATE purchase_orders SET status = 'CANCELLED' WHERE id = ${id} AND status IN ('PENDING', 'APPROVED', 'PARTIAL') RETURNING *`;
      if (!po) {
        if (!(await tx`SELECT 1 FROM purchase_orders WHERE id = ${id}`).length) throw notFound();
        throw new HTTPException(409, { message: `This order can't be ${action === "approve" ? "approved" : "cancelled"} in its current status` });
      }
      await audit(tx, { businessId: bid, userId: sub, action: `po.${action}`, entity: "purchase_order", entityId: id });
      return po;
    }));
  })
  .post("/purchase-orders/:id/receive", requirePermission("stock.adjust.approve"), zValidator("json", receiveOrderSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const id = c.req.param("id");
    const b = c.req.valid("json");
    if (!UUID.test(id)) throw notFound();
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const [po] = await tx`SELECT * FROM purchase_orders WHERE id = ${id} FOR UPDATE`;
      if (!po) throw notFound();
      if (!["APPROVED", "PARTIAL"].includes(po.status)) throw new HTTPException(409, { message: "Only approved orders can be received" });
      const lines = await tx`SELECT * FROM purchase_order_lines WHERE purchase_order_id = ${id}`;
      const goods: GoodsLine[] = [];
      for (const r of b.lines) {
        const l = lines.find((x) => x.product_id === r.productId);
        if (!l) throw new HTTPException(422, { message: "That product is not on this order" });
        const outstanding = Number(l.quantity_ordered) - Number(l.quantity_received);
        if (r.quantity > outstanding + 1e-9) throw new HTTPException(409, { message: `Only ${outstanding} still to receive for this product` });
        // Cost the receipt as the change in the line's rounded received value, so split deliveries sum to the order line total.
        const cost = Number(l.unit_cost_cents);
        const before = Number(l.quantity_received);
        const totalCents = Math.round((before + r.quantity) * cost) - Math.round(before * cost);
        goods.push({ productId: r.productId, quantity: r.quantity, unitCostCents: cost, totalCents });
        await tx`UPDATE purchase_order_lines SET quantity_received = quantity_received + ${r.quantity} WHERE id = ${l.id}`;
      }
      const purchase = await receiveGoods(tx, { bid, sub, branchId: po.branch_id, supplierId: po.supplier_id, supplierRef: b.supplierRef, purchaseOrderId: id, lines: goods });
      const [{ open }] = (await tx`SELECT count(*)::int AS open FROM purchase_order_lines WHERE purchase_order_id = ${id} AND quantity_received < quantity_ordered`) as unknown as [{ open: number }];
      const status = open ? "PARTIAL" : "RECEIVED";
      await tx`UPDATE purchase_orders SET status = ${status} WHERE id = ${id}`;
      await audit(tx, { businessId: bid, userId: sub, action: "po.receive", entity: "purchase_order", entityId: id, after: b });
      return { purchase, status };
    }), 201);
  });
