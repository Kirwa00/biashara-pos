import { roundQty, transferReceiveSchema, transferSchema } from "@kpos/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type postgres from "postgres";
import { requireAuth, requirePermission } from "../auth";
import { audit, withTenant } from "../db";
import type { AppEnv } from "../env";
import { nextNumber } from "./documents";
import { postMovement, resolveBranch } from "./stock";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function lockTransfer(tx: postgres.TransactionSql, id: string) {
  if (!UUID.test(id)) throw new HTTPException(404, { message: "Transfer not found" });
  const [t] = await tx`SELECT * FROM stock_transfers WHERE id = ${id} FOR UPDATE`;
  if (!t) throw new HTTPException(404, { message: "Transfer not found" });
  return t;
}

/** Branch-to-branch stock transfers: raise, send (stock leaves the source), receive (stock arrives at the destination at the source's cost). */
export const transferRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/transfers", requirePermission("stock.view"), async (c) => {
    const status = c.req.query("status");
    return c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`
      SELECT t.*, fb.name AS from_branch, tb.name AS to_branch,
        (SELECT count(*)::int FROM stock_transfer_lines l WHERE l.transfer_id = t.id) AS lines,
        (SELECT coalesce(round(sum(l.quantity * l.unit_cost_cents)), 0) FROM stock_transfer_lines l WHERE l.transfer_id = t.id) AS value_cents,
        coalesce((SELECT bool_or(l.quantity_received < l.quantity) FROM stock_transfer_lines l WHERE l.transfer_id = t.id), false) AS short
      FROM stock_transfers t JOIN branches fb ON fb.id = t.from_branch_id JOIN branches tb ON tb.id = t.to_branch_id
      ${status ? tx`WHERE t.status = ${status}` : tx``} ORDER BY t.number DESC LIMIT 200`));
  })
  .get("/transfers/:id", requirePermission("stock.view"), async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) throw new HTTPException(404, { message: "Transfer not found" });
    return c.json(await withTenant(c.get("sql"), c.get("auth").bid, async (tx) => {
      const [t] = await tx`SELECT t.*, fb.name AS from_branch, tb.name AS to_branch FROM stock_transfers t
        JOIN branches fb ON fb.id = t.from_branch_id JOIN branches tb ON tb.id = t.to_branch_id WHERE t.id = ${id}`;
      if (!t) throw new HTTPException(404, { message: "Transfer not found" });
      return { ...t, lines: await tx`SELECT l.*, p.sku, p.name FROM stock_transfer_lines l JOIN products p ON p.id = l.product_id WHERE l.transfer_id = ${id} ORDER BY l.id` };
    }));
  })
  .post("/transfers", requirePermission("stock.adjust"), zValidator("json", transferSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const b = c.req.valid("json");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      await resolveBranch(tx, sub, b.fromBranchId);
      const [to] = await tx`SELECT id FROM branches WHERE id = ${b.toBranchId} AND is_active`;
      if (!to) throw new HTTPException(400, { message: "Unknown destination branch" });
      const ids = b.lines.map((l) => l.productId);
      const found = await tx`SELECT id FROM products WHERE is_active AND track_stock AND id IN ${tx(ids)}`;
      if (found.length !== ids.length) throw new HTTPException(400, { message: "Only active, stock-tracked products can be transferred" });
      const [t] = await tx`INSERT INTO stock_transfers (business_id, number, from_branch_id, to_branch_id, note, created_by)
        VALUES (${bid}, ${await nextNumber(tx, bid, "TRANSFER")}, ${b.fromBranchId}, ${b.toBranchId}, ${b.note ?? null}, ${sub}) RETURNING *`;
      for (const l of b.lines)
        await tx`INSERT INTO stock_transfer_lines (business_id, transfer_id, product_id, quantity) VALUES (${bid}, ${t!.id}, ${l.productId}, ${l.quantity})`;
      await audit(tx, { businessId: bid, userId: sub, action: "transfer.create", entity: "stock_transfer", entityId: t!.id, after: b });
      return t;
    }), 201);
  })
  .post("/transfers/:id/send", requirePermission("stock.adjust"), async (c) => {
    const { sub, bid } = c.get("auth");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const t = await lockTransfer(tx, c.req.param("id"));
      if (t.status !== "PENDING") throw new HTTPException(409, { message: `Transfer is already ${t.status.toLowerCase().replace("_", " ")}` });
      await resolveBranch(tx, sub, t.from_branch_id);
      // Product order keeps balance-row locks in a consistent order across concurrent transfers.
      for (const l of await tx`SELECT * FROM stock_transfer_lines WHERE transfer_id = ${t.id} ORDER BY product_id`) {
        const [bal] = await tx`SELECT avg_cost_cents FROM stock_balances WHERE branch_id = ${t.from_branch_id} AND product_id = ${l.product_id}`;
        await postMovement(tx, { businessId: bid, branchId: t.from_branch_id, productId: l.product_id, type: "TRANSFER_OUT", quantity: -Number(l.quantity), refType: "transfer", refId: t.id, userId: sub });
        await tx`UPDATE stock_transfer_lines SET unit_cost_cents = ${Number(bal?.avg_cost_cents ?? 0)} WHERE id = ${l.id}`;
      }
      const [r] = await tx`UPDATE stock_transfers SET status = 'IN_TRANSIT', sent_by = ${sub}, sent_at = now() WHERE id = ${t.id} RETURNING *`;
      await audit(tx, { businessId: bid, userId: sub, action: "transfer.send", entity: "stock_transfer", entityId: t.id });
      return r;
    }));
  })
  .post("/transfers/:id/receive", requirePermission("stock.adjust"), zValidator("json", transferReceiveSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const b = c.req.valid("json");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const t = await lockTransfer(tx, c.req.param("id"));
      if (t.status !== "IN_TRANSIT") throw new HTTPException(409, { message: t.status === "PENDING" ? "Send the transfer before receiving it" : `Transfer is already ${t.status.toLowerCase()}` });
      await resolveBranch(tx, sub, t.to_branch_id);
      const lines = await tx`SELECT l.*, p.name FROM stock_transfer_lines l JOIN products p ON p.id = l.product_id WHERE l.transfer_id = ${t.id} ORDER BY l.product_id`;
      const got = new Map(b.lines?.map((l) => [l.productId, l.quantity]));
      if (b.lines?.some((l) => !lines.find((x) => x.product_id === l.productId))) throw new HTTPException(422, { message: "A received product is not on this transfer" });
      for (const l of lines) {
        // With explicit lines, anything not listed did not arrive.
        const qty = roundQty(b.lines ? (got.get(l.product_id) ?? 0) : Number(l.quantity));
        if (qty > Number(l.quantity)) throw new HTTPException(409, { message: `Cannot receive more ${l.name} than was sent` });
        if (qty > 0) await postMovement(tx, { businessId: bid, branchId: t.to_branch_id, productId: l.product_id, type: "TRANSFER_IN", quantity: qty,
          unitCostCents: Number(l.unit_cost_cents), refType: "transfer", refId: t.id, userId: sub });
        await tx`UPDATE stock_transfer_lines SET quantity_received = ${qty} WHERE id = ${l.id}`;
      }
      const [r] = await tx`UPDATE stock_transfers SET status = 'RECEIVED', received_by = ${sub}, received_at = now() WHERE id = ${t.id} RETURNING *`;
      await audit(tx, { businessId: bid, userId: sub, action: "transfer.receive", entity: "stock_transfer", entityId: t.id, after: b.lines ?? "all" });
      return r;
    }));
  })
  .post("/transfers/:id/cancel", requirePermission("stock.adjust"), async (c) => {
    const { sub, bid } = c.get("auth");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const t = await lockTransfer(tx, c.req.param("id"));
      if (t.status !== "PENDING") throw new HTTPException(409, { message: "Only transfers not yet sent can be cancelled" });
      const [r] = await tx`UPDATE stock_transfers SET status = 'CANCELLED' WHERE id = ${t.id} RETURNING *`;
      await audit(tx, { businessId: bid, userId: sub, action: "transfer.cancel", entity: "stock_transfer", entityId: t.id });
      return r;
    }));
  });
