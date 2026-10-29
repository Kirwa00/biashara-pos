import { openingStockSchema, roundQty, stockAdjustmentSchema, stockCountSchema, weightedAvgCost } from "@kpos/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type postgres from "postgres";
import { requireAuth, requirePermission } from "../auth";
import { audit, withTenant } from "../db";
import type { AppEnv } from "../env";

type Tx = postgres.TransactionSql;
type MovementType = "OPENING" | "ADJUSTMENT" | "COUNT" | "SALE" | "PURCHASE" | "RETURN" | "TRANSFER_IN" | "TRANSFER_OUT";
type Movement = {
  businessId: string; branchId: string; productId: string; type: MovementType; quantity: number;
  unitCostCents?: number; reason?: string; refType?: string; refId?: string; userId: string;
};

/** The only way stock changes: locks the balance row, enforces the negative-stock policy, appends to the ledger. */
export async function postMovement(tx: Tx, m: Movement) {
  await tx`INSERT INTO stock_balances (business_id, branch_id, product_id) VALUES (${m.businessId}, ${m.branchId}, ${m.productId}) ON CONFLICT DO NOTHING`;
  const [bal] = await tx`SELECT on_hand, avg_cost_cents FROM stock_balances
    WHERE business_id = ${m.businessId} AND branch_id = ${m.branchId} AND product_id = ${m.productId} FOR UPDATE`;
  const onHand = Number(bal!.on_hand);
  const avg = Number(bal!.avg_cost_cents);
  const after = roundQty(onHand + m.quantity);
  if (after < 0) {
    const [biz] = await tx`SELECT allow_negative_stock FROM businesses WHERE id = ${m.businessId}`;
    if (!biz?.allow_negative_stock) throw new HTTPException(409, { message: `Insufficient stock: ${onHand} on hand` });
  }
  const inbound = m.quantity > 0 && m.unitCostCents !== undefined;
  const newAvg = inbound ? weightedAvgCost(onHand, avg, m.quantity, m.unitCostCents!) : avg;
  await tx`INSERT INTO stock_movements (business_id, branch_id, product_id, type, quantity, unit_cost_cents, balance_after, reason, ref_type, ref_id, created_by)
    VALUES (${m.businessId}, ${m.branchId}, ${m.productId}, ${m.type}, ${m.quantity}, ${inbound ? m.unitCostCents! : avg}, ${after},
            ${m.reason ?? null}, ${m.refType ?? null}, ${m.refId ?? null}, ${m.userId})`;
  await tx`UPDATE stock_balances SET on_hand = ${after}, avg_cost_cents = ${newAvg}, updated_at = now()
    WHERE business_id = ${m.businessId} AND branch_id = ${m.branchId} AND product_id = ${m.productId}`;
  return { onHand: after, avgCostCents: newAvg };
}

export async function resolveBranch(tx: Tx, userId: string, branchId?: string): Promise<string> {
  const [u] = await tx`SELECT role, branch_id FROM users WHERE id = ${userId}`;
  if (branchId && u?.branch_id && u.branch_id !== branchId && !["OWNER", "MANAGER"].includes(u.role))
    throw new HTTPException(403, { message: "You can only work in your own branch" });
  const [b] = branchId
    ? await tx`SELECT id FROM branches WHERE id = ${branchId}`
    : await tx`SELECT coalesce(u.branch_id, (SELECT id FROM branches ORDER BY (code = 'MAIN') DESC, created_at LIMIT 1)) AS id FROM users u WHERE u.id = ${userId}`;
  if (!b?.id) throw new HTTPException(400, { message: "Unknown branch" });
  return b.id as string;
}

function assertUniqueProducts(lines: { productId: string }[]) {
  if (new Set(lines.map((l) => l.productId)).size !== lines.length) throw new HTTPException(422, { message: "Each product may appear once" });
}

export const stockRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/stock", requirePermission("stock.view"), async (c) => {
    const { sub, bid } = c.get("auth");
    const lowOnly = c.req.query("low") === "1";
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const branchId = await resolveBranch(tx, sub, c.req.query("branchId"));
      return tx`
        SELECT p.id AS product_id, p.sku, p.name, p.base_unit, p.reorder_level, ${branchId}::uuid AS branch_id,
               coalesce(b.on_hand, 0) AS on_hand, coalesce(b.avg_cost_cents, 0) AS avg_cost_cents,
               (p.reorder_level > 0 AND coalesce(b.on_hand, 0) <= p.reorder_level) AS low_stock
        FROM products p
        LEFT JOIN stock_balances b ON b.product_id = p.id AND b.branch_id = ${branchId}
        WHERE p.is_active AND p.track_stock
          ${lowOnly ? tx`AND p.reorder_level > 0 AND coalesce(b.on_hand, 0) <= p.reorder_level` : tx``}
        ORDER BY lower(p.name) LIMIT 1000`;
    }));
  })
  .get("/stock/movements", requirePermission("stock.view"), async (c) => {
    const productId = c.req.query("productId");
    if (!productId) throw new HTTPException(400, { message: "productId is required" });
    return c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`
      SELECT m.*, u.name AS created_by_name FROM stock_movements m LEFT JOIN users u ON u.id = m.created_by
      WHERE m.product_id = ${productId} ${c.req.query("branchId") ? tx`AND m.branch_id = ${c.req.query("branchId")!}` : tx``}
      ORDER BY m.id DESC LIMIT 500`));
  })
  .post("/stock/opening", requirePermission("stock.adjust.approve"), zValidator("json", openingStockSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const body = c.req.valid("json");
    assertUniqueProducts(body.lines);
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const branchId = await resolveBranch(tx, sub, body.branchId);
      const ids = body.lines.map((l) => l.productId);
      for (const id of [...ids].sort()) await tx`SELECT pg_advisory_xact_lock(hashtext(${`opening:${branchId}:${id}`}))`;
      const [existing] = await tx`SELECT product_id FROM stock_movements WHERE branch_id = ${branchId} AND product_id IN ${tx(ids)} LIMIT 1`;
      if (existing) throw new HTTPException(409, { message: "Opening stock already recorded for a product; use an adjustment" });
      for (const l of body.lines)
        await postMovement(tx, { businessId: bid, branchId, productId: l.productId, type: "OPENING", quantity: l.quantity, unitCostCents: l.unitCostCents, reason: "Opening stock", userId: sub });
      await audit(tx, { businessId: bid, userId: sub, action: "stock.opening", entity: "branch", entityId: branchId, after: { lines: body.lines } });
      return { posted: body.lines.length };
    }), 201);
  })
  .get("/stock/adjustments", requirePermission("stock.view"), async (c) => {
    const status = c.req.query("status");
    return c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`
      SELECT a.*, p.name AS product_name, p.sku, r.name AS requested_by_name
      FROM stock_adjustments a JOIN products p ON p.id = a.product_id JOIN users r ON r.id = a.requested_by
      ${status ? tx`WHERE a.status = ${status}` : tx``} ORDER BY a.created_at DESC LIMIT 200`));
  })
  .post("/stock/adjustments", requirePermission("stock.adjust"), zValidator("json", stockAdjustmentSchema), async (c) => {
    const { sub, bid, role } = c.get("auth");
    const body = c.req.valid("json");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const branchId = await resolveBranch(tx, sub, body.branchId);
      const selfApprove = role === "OWNER";
      const [adj] = await tx`INSERT INTO stock_adjustments (business_id, branch_id, product_id, quantity, reason, status, requested_by, decided_by, decided_at)
        VALUES (${bid}, ${branchId}, ${body.productId}, ${body.quantity}, ${body.reason}, ${selfApprove ? "APPROVED" : "PENDING"}, ${sub},
                ${selfApprove ? sub : null}, ${selfApprove ? tx`now()` : null}) RETURNING *`;
      if (selfApprove)
        await postMovement(tx, { businessId: bid, branchId, productId: body.productId, type: "ADJUSTMENT", quantity: body.quantity, reason: body.reason, refType: "adjustment", refId: adj!.id, userId: sub });
      await audit(tx, { businessId: bid, userId: sub, action: "stock.adjust.request", entity: "stock_adjustment", entityId: adj!.id, after: body });
      return adj;
    }), 201);
  })
  .post("/stock/adjustments/:id/:decision{approve|reject}", requirePermission("stock.adjust.approve"), async (c) => {
    const { sub, bid, role } = c.get("auth");
    const id = c.req.param("id");
    const approve = c.req.param("decision") === "approve";
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const [adj] = await tx`SELECT * FROM stock_adjustments WHERE id = ${id} FOR UPDATE`;
      if (!adj) throw new HTTPException(404, { message: "Adjustment not found" });
      if (adj.status !== "PENDING") throw new HTTPException(409, { message: `Adjustment already ${adj.status.toLowerCase()}` });
      if (adj.requested_by === sub && role !== "OWNER") throw new HTTPException(403, { message: "Another manager must approve your adjustment" });
      if (approve)
        await postMovement(tx, { businessId: bid, branchId: adj.branch_id, productId: adj.product_id, type: "ADJUSTMENT", quantity: Number(adj.quantity), reason: adj.reason, refType: "adjustment", refId: id, userId: sub });
      const [r] = await tx`UPDATE stock_adjustments SET status = ${approve ? "APPROVED" : "REJECTED"}, decided_by = ${sub}, decided_at = now() WHERE id = ${id} RETURNING *`;
      await audit(tx, { businessId: bid, userId: sub, action: approve ? "stock.adjust.approve" : "stock.adjust.reject", entity: "stock_adjustment", entityId: id, before: adj, after: r });
      return r;
    }));
  })
  .post("/stock/counts", requirePermission("stock.adjust.approve"), zValidator("json", stockCountSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const body = c.req.valid("json");
    assertUniqueProducts(body.lines);
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const branchId = await resolveBranch(tx, sub, body.branchId);
      const [count] = await tx`INSERT INTO stock_counts (business_id, branch_id, note, counted_by) VALUES (${bid}, ${branchId}, ${body.note ?? null}, ${sub}) RETURNING *`;
      const lines = [];
      for (const l of body.lines) {
        await tx`INSERT INTO stock_balances (business_id, branch_id, product_id) VALUES (${bid}, ${branchId}, ${l.productId}) ON CONFLICT DO NOTHING`;
        const [bal] = await tx`SELECT on_hand FROM stock_balances WHERE business_id = ${bid} AND branch_id = ${branchId} AND product_id = ${l.productId} FOR UPDATE`;
        const expected = Number(bal!.on_hand);
        const variance = roundQty(l.counted - expected);
        if (variance !== 0)
          await postMovement(tx, { businessId: bid, branchId, productId: l.productId, type: "COUNT", quantity: variance, reason: body.note || "Stock count", refType: "count", refId: count!.id, userId: sub });
        const [line] = await tx`INSERT INTO stock_count_lines (business_id, count_id, product_id, expected, counted, variance)
          VALUES (${bid}, ${count!.id}, ${l.productId}, ${expected}, ${l.counted}, ${variance}) RETURNING product_id, expected, counted, variance`;
        lines.push(line);
      }
      await audit(tx, { businessId: bid, userId: sub, action: "stock.count", entity: "stock_count", entityId: count!.id, after: { lines } });
      return { ...count, lines };
    }), 201);
  });
