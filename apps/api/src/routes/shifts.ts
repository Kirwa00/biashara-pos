import { closeShiftSchema, openShiftSchema } from "@kpos/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type postgres from "postgres";
import { requireAuth, requirePermission } from "../auth";
import { audit, withTenant } from "../db";
import type { AppEnv } from "../env";
import { resolveBranch } from "./stock";

type Tx = postgres.TransactionSql;

/** X/Z report: confirmed takings per method during the shift, refunds netted. */
async function summary(tx: Tx, shift: postgres.Row) {
  const byMethod = await tx`SELECT method, coalesce(sum(amount_cents * direction), 0) AS amount_cents, count(*)::int AS count
    FROM payments WHERE shift_id = ${shift.id} AND status = 'CONFIRMED' GROUP BY method ORDER BY method`;
  const cash = Number(byMethod.find((m) => m.method === "CASH")?.amount_cents ?? 0);
  const expected = Number(shift.opening_float_cents) + cash;
  const variance = shift.counted_cash_cents == null ? null : Number(shift.counted_cash_cents) - expected;
  return { ...shift, by_method: byMethod, expected_cash_cents: expected, variance_cents: variance };
}

export const currentShiftId = (tx: Tx, userId: string) => tx`(SELECT id FROM shifts WHERE user_id = ${userId} AND status = 'OPEN')`;

export const shiftRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/shifts/current", async (c) => {
    const { sub, bid } = c.get("auth");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const [s] = await tx`SELECT * FROM shifts WHERE user_id = ${sub} AND status = 'OPEN'`;
      return s ? summary(tx, s) : null;
    }));
  })
  .get("/shifts", requirePermission("reports.view"), async (c) =>
    c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) =>
      tx`SELECT s.*, u.name AS user_name FROM shifts s JOIN users u ON u.id = s.user_id ORDER BY s.opened_at DESC LIMIT 100`)))
  .get("/shifts/:id", async (c) => {
    const { sub, bid, role } = c.get("auth");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const [s] = await tx`SELECT * FROM shifts WHERE id = ${c.req.param("id")}`;
      if (!s || (s.user_id !== sub && role === "CASHIER")) throw new HTTPException(404, { message: "Shift not found" });
      return summary(tx, s);
    }));
  })
  .post("/shifts/open", requirePermission("shift.open"), zValidator("json", openShiftSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const b = c.req.valid("json");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const branchId = await resolveBranch(tx, sub, b.branchId);
      const [open] = await tx`SELECT id FROM shifts WHERE user_id = ${sub} AND status = 'OPEN'`;
      if (open) throw new HTTPException(409, { message: "You already have an open shift" });
      const [s] = await tx`INSERT INTO shifts (business_id, branch_id, user_id, opening_float_cents) VALUES (${bid}, ${branchId}, ${sub}, ${b.openingFloatCents}) RETURNING *`;
      await audit(tx, { businessId: bid, userId: sub, action: "shift.open", entity: "shift", entityId: s!.id, after: b });
      return summary(tx, s!);
    }), 201);
  })
  .post("/shifts/:id/close", requirePermission("shift.close"), zValidator("json", closeShiftSchema), async (c) => {
    const { sub, bid, role } = c.get("auth");
    const b = c.req.valid("json");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const [s] = await tx`SELECT * FROM shifts WHERE id = ${c.req.param("id")} AND status = 'OPEN' FOR UPDATE`;
      if (!s || (s.user_id !== sub && role === "CASHIER")) throw new HTTPException(404, { message: "Open shift not found" });
      const { expected_cash_cents } = await summary(tx, s);
      const [closed] = await tx`UPDATE shifts SET status = 'CLOSED', closed_at = now(), expected_cash_cents = ${expected_cash_cents},
        counted_cash_cents = ${b.countedCashCents}, note = ${b.note ?? null} WHERE id = ${s.id} RETURNING *`;
      await audit(tx, { businessId: bid, userId: sub, action: "shift.close", entity: "shift", entityId: s.id, after: { ...b, expected_cash_cents } });
      return summary(tx, closed!);
    }));
  });
