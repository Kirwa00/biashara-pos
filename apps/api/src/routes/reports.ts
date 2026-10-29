import { Hono } from "hono";
import { requireAuth, requirePermission } from "../auth";
import { withTenant } from "../db";
import type { AppEnv } from "../env";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const reportRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/reports/summary", requirePermission("reports.view"), async (c) => {
    const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
    const from = DATE.test(c.req.query("from") ?? "") ? c.req.query("from")! : today;
    const to = DATE.test(c.req.query("to") ?? "") ? c.req.query("to")! : today;
    return c.json(await withTenant(c.get("sql"), c.get("auth").bid, async (tx) => {
      const [sales] = await tx`SELECT count(*)::int AS count, coalesce(sum(total_cents), 0) AS total_cents, coalesce(sum(tax_cents), 0) AS tax_cents
        FROM documents WHERE type IN ('INVOICE','SALE') AND issue_date BETWEEN ${from} AND ${to}`;
      const [profit] = await tx`SELECT coalesce(sum(l.net_cents - round(l.unit_cost_cents * l.quantity)), 0) AS gross_profit_cents
        FROM document_lines l JOIN documents d ON d.id = l.document_id WHERE d.type IN ('INVOICE','SALE') AND d.issue_date BETWEEN ${from} AND ${to}`;
      const received = await tx`SELECT method, coalesce(sum(amount_cents), 0) AS amount_cents FROM payments
        WHERE status = 'CONFIRMED' AND (created_at AT TIME ZONE 'Africa/Nairobi')::date BETWEEN ${from} AND ${to} GROUP BY method ORDER BY method`;
      const [owed] = await tx`SELECT coalesce(sum(total_cents - paid_cents), 0) AS receivable_cents,
          coalesce(sum(total_cents - paid_cents) FILTER (WHERE due_date < (now() AT TIME ZONE 'Africa/Nairobi')::date), 0) AS overdue_cents
        FROM documents WHERE type IN ('INVOICE','SALE') AND status IN ('UNPAID','PARTIAL')`;
      const [stock] = await tx`SELECT coalesce(round(sum(b.on_hand * b.avg_cost_cents)), 0) AS stock_value_cents,
          count(*) FILTER (WHERE p.reorder_level > 0 AND b.on_hand <= p.reorder_level)::int AS low_stock
        FROM products p LEFT JOIN stock_balances b ON b.product_id = p.id WHERE p.is_active AND p.track_stock`;
      return { from, to, sales, ...profit, received, ...owed, ...stock };
    }));
  });
