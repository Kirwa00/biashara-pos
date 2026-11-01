import { expenseSchema, isIsoDate } from "@kpos/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth, requirePermission } from "../auth";
import { audit, withTenant } from "../db";
import { resolveBranch } from "./stock";
import type { AppEnv } from "../env";
import type postgres from "postgres";

const nairobiToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const range = (q: (k: string) => string | undefined) => {
  const today = nairobiToday();
  return { from: isIsoDate(q("from") ?? "") ? q("from")! : today, to: isIsoDate(q("to") ?? "") ? q("to")! : today };
};

/** One row per tracked product at or below its reorder level, stock summed across branches (no balance row = 0). */
const lowStock = (tx: postgres.TransactionSql) => tx`SELECT p.id, p.sku, p.name, coalesce(sum(b.on_hand), 0) AS on_hand, p.reorder_level
  FROM products p LEFT JOIN stock_balances b ON b.product_id = p.id
  WHERE p.is_active AND p.track_stock AND p.reorder_level > 0
  GROUP BY p.id HAVING coalesce(sum(b.on_hand), 0) <= p.reorder_level`;

export const reportRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  /** Stock at average cost: current balances, or replayed from the ledger as at the end of `asOf` (Nairobi date). */
  .get("/reports/stock-valuation", requirePermission("reports.view"), async (c) => {
    const asOf = c.req.query("asOf");
    if (asOf !== undefined && !isIsoDate(asOf)) throw new HTTPException(400, { message: "asOf must be YYYY-MM-DD" });
    return c.json(await withTenant(c.get("sql"), c.get("auth").bid, async (tx) => {
      const src = asOf
        ? tx`SELECT product_id, sum(balance_after) AS qty, sum(balance_after * coalesce(avg_cost_after, unit_cost_cents)) AS value FROM (
            SELECT DISTINCT ON (branch_id, product_id) branch_id, product_id, balance_after, avg_cost_after, unit_cost_cents FROM stock_movements
            WHERE (created_at AT TIME ZONE 'Africa/Nairobi')::date <= ${asOf} ORDER BY branch_id, product_id, created_at DESC, id DESC) last GROUP BY product_id`
        : tx`SELECT product_id, sum(on_hand) AS qty, sum(on_hand * avg_cost_cents) AS value FROM stock_balances GROUP BY product_id`;
      const products = await tx`SELECT p.id, p.sku, p.name, coalesce(cat.name, 'Uncategorised') AS category, s.qty AS on_hand,
          round(s.value) AS value_cents, CASE WHEN s.qty <> 0 THEN round(s.value / s.qty) ELSE 0 END AS avg_cost_cents
        FROM (${src}) s JOIN products p ON p.id = s.product_id LEFT JOIN categories cat ON cat.id = p.category_id
        WHERE (s.qty <> 0 OR round(s.value) <> 0) ${asOf ? tx`` : tx`AND p.is_active AND p.track_stock`} ORDER BY round(s.value) DESC, p.name`;
      const byCat = new Map<string, number>();
      for (const p of products) byCat.set(p.category, (byCat.get(p.category) ?? 0) + Number(p.value_cents));
      return {
        as_of: asOf ?? nairobiToday(),
        total_cents: String(products.reduce((s, p) => s + Number(p.value_cents), 0)),
        categories: [...byCat].map(([category, v]) => ({ category, value_cents: String(v) })).sort((a, b) => Number(b.value_cents) - Number(a.value_cents)),
        products,
      };
    }));
  })
  /** Profit & loss by month (net of VAT): sales, returns, cost of goods sold, gross profit, expenses by category, net profit. */
  .get("/reports/pnl", requirePermission("reports.view"), async (c) => {
    const { from, to } = range((k) => c.req.query(k));
    if (from > to) throw new HTTPException(400, { message: "from must be on or before to" });
    return c.json(await withTenant(c.get("sql"), c.get("auth").bid, async (tx) => {
      const trade = await tx`SELECT to_char(d.issue_date, 'YYYY-MM') AS month,
          coalesce(sum(l.net_cents) FILTER (WHERE d.type <> 'CREDIT_NOTE'), 0) AS sales,
          coalesce(sum(l.net_cents) FILTER (WHERE d.type = 'CREDIT_NOTE'), 0) AS returns,
          coalesce(sum(round(l.unit_cost_cents * l.quantity) * CASE WHEN d.type = 'CREDIT_NOTE' THEN -1 ELSE 1 END), 0) AS cogs
        FROM document_lines l JOIN documents d ON d.id = l.document_id
        WHERE d.type IN ('INVOICE','SALE','CREDIT_NOTE') AND d.issue_date BETWEEN ${from} AND ${to} GROUP BY 1`;
      const spend = await tx`SELECT to_char(expense_date, 'YYYY-MM') AS month, category, sum(amount_cents) AS amount
        FROM expenses WHERE expense_date BETWEEN ${from} AND ${to} GROUP BY 1, 2`;
      const blank = () => ({ sales: 0, returns: 0, cogs: 0, expenses: {} as Record<string, number> });
      const months = new Map<string, ReturnType<typeof blank>>();
      const at = (m: string) => months.get(m) ?? months.set(m, blank()).get(m)!;
      for (const r of trade) Object.assign(at(r.month), { sales: Number(r.sales), returns: Number(r.returns), cogs: Number(r.cogs) });
      for (const r of spend) at(r.month).expenses[r.category] = Number(r.amount);
      const total = blank();
      for (const m of months.values()) {
        total.sales += m.sales; total.returns += m.returns; total.cogs += m.cogs;
        for (const [k, v] of Object.entries(m.expenses)) total.expenses[k] = (total.expenses[k] ?? 0) + v;
      }
      const statement = (period: string, m: ReturnType<typeof blank>) => {
        const net_sales = m.sales - m.returns, gross_profit = net_sales - m.cogs;
        const expenses_total = Object.values(m.expenses).reduce((s, v) => s + v, 0);
        const str = (n: number) => String(n);
        return { period, sales_cents: str(m.sales), returns_cents: str(m.returns), net_sales_cents: str(net_sales), cogs_cents: str(m.cogs),
          gross_profit_cents: str(gross_profit), expenses: Object.fromEntries(Object.entries(m.expenses).map(([k, v]) => [k, str(v)])),
          expenses_cents: str(expenses_total), net_profit_cents: str(gross_profit - expenses_total) };
      };
      return { from, to, months: [...months.keys()].sort().map((k) => statement(k, months.get(k)!)), total: statement("TOTAL", total) };
    }));
  })
  .get("/reports/summary", requirePermission("reports.view"), async (c) => {
    const { from, to } = range((k) => c.req.query(k));
    return c.json(await withTenant(c.get("sql"), c.get("auth").bid, async (tx) => {
      const [sales] = await tx`SELECT count(*)::int AS count, coalesce(sum(total_cents), 0) AS total_cents, coalesce(sum(tax_cents), 0) AS tax_cents
        FROM documents WHERE type IN ('INVOICE','SALE') AND issue_date BETWEEN ${from} AND ${to}`;
      const [profit] = await tx`SELECT coalesce(sum((l.net_cents - round(l.unit_cost_cents * l.quantity)) * CASE WHEN d.type = 'CREDIT_NOTE' THEN -1 ELSE 1 END), 0) AS gross_profit_cents
        FROM document_lines l JOIN documents d ON d.id = l.document_id WHERE d.type IN ('INVOICE','SALE','CREDIT_NOTE') AND d.issue_date BETWEEN ${from} AND ${to}`;
      const [returns] = await tx`SELECT count(*)::int AS count, coalesce(sum(total_cents), 0) AS total_cents, coalesce(sum(tax_cents), 0) AS tax_cents
        FROM documents WHERE type = 'CREDIT_NOTE' AND issue_date BETWEEN ${from} AND ${to}`;
      const received = await tx`SELECT method, coalesce(sum(amount_cents * direction), 0) AS amount_cents FROM payments
        WHERE status = 'CONFIRMED' AND (created_at AT TIME ZONE 'Africa/Nairobi')::date BETWEEN ${from} AND ${to} GROUP BY method ORDER BY method`;
      const [owed] = await tx`SELECT coalesce(sum(total_cents - paid_cents), 0) AS receivable_cents,
          coalesce(sum(total_cents - paid_cents) FILTER (WHERE due_date < (now() AT TIME ZONE 'Africa/Nairobi')::date), 0) AS overdue_cents
        FROM documents WHERE type IN ('INVOICE','SALE') AND status IN ('UNPAID','PARTIAL')`;
      const [stock] = await tx`SELECT coalesce(round(sum(b.on_hand * b.avg_cost_cents)), 0) AS stock_value_cents
        FROM products p JOIN stock_balances b ON b.product_id = p.id WHERE p.is_active AND p.track_stock`;
      const [low] = await tx`SELECT count(*)::int AS low_stock FROM (${lowStock(tx)}) x`;
      const [exp] = await tx`SELECT coalesce(sum(amount_cents), 0) AS expenses_cents FROM expenses WHERE expense_date BETWEEN ${from} AND ${to}`;
      const [pay] = await tx`SELECT (SELECT coalesce(sum(total_cents), 0) FROM purchases) - (SELECT coalesce(sum(amount_cents), 0) FROM supplier_payments) AS payable_cents`;
      const net_profit_cents = String(Number(profit!.gross_profit_cents) - Number(exp!.expenses_cents));
      return { from, to, sales, returns, ...profit, ...exp, net_profit_cents, received, ...owed, ...pay, ...stock, ...low };
    }));
  })
  // Sales net of returns, grouped by product, category or cashier.
  .get("/reports/breakdown", requirePermission("reports.view"), async (c) => {
    const by = c.req.query("by") ?? "product";
    if (!["product", "category", "cashier"].includes(by)) throw new HTTPException(400, { message: "by must be product, category or cashier" });
    const { from, to } = range((k) => c.req.query(k));
    return c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => {
      const [key, label] = by === "product" ? [tx`l.product_id::text`, tx`p.name`]
        : by === "category" ? [tx`coalesce(cat.id::text, 'none')`, tx`coalesce(cat.name, 'Uncategorised')`]
        : [tx`u.id::text`, tx`u.name`];
      return tx`
        SELECT ${key} AS key, ${label} AS label, sum(l.quantity * sg.s) AS quantity, sum(l.total_cents * sg.s) AS total_cents,
          sum((l.net_cents - round(l.unit_cost_cents * l.quantity)) * sg.s) AS gross_profit_cents
        FROM document_lines l JOIN documents d ON d.id = l.document_id
        JOIN products p ON p.id = l.product_id LEFT JOIN categories cat ON cat.id = l.category_id JOIN users u ON u.id = d.created_by
        CROSS JOIN LATERAL (SELECT CASE WHEN d.type = 'CREDIT_NOTE' THEN -1 ELSE 1 END AS s) sg
        WHERE d.type IN ('INVOICE','SALE','CREDIT_NOTE') AND d.issue_date BETWEEN ${from} AND ${to}
        GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 50`;
    }));
  })
  .get("/expenses", requirePermission("reports.view"), async (c) => {
    const { from, to } = range((k) => c.req.query(k));
    return c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) =>
      tx`SELECT * FROM expenses WHERE expense_date BETWEEN ${from} AND ${to} ORDER BY expense_date DESC, created_at DESC LIMIT 500`));
  })
  .post("/expenses", requirePermission("invoices.manage"), zValidator("json", expenseSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const b = c.req.valid("json");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const branchId = await resolveBranch(tx, sub, b.branchId);
      const [e] = await tx`INSERT INTO expenses (business_id, branch_id, category, description, amount_cents, method, expense_date, created_by)
        VALUES (${bid}, ${branchId}, ${b.category}, ${b.description ?? null}, ${b.amountCents}, ${b.method}, ${b.expenseDate ?? nairobiToday()}, ${sub}) RETURNING *`;
      await audit(tx, { businessId: bid, userId: sub, action: "expense.create", entity: "expense", entityId: e!.id, after: b });
      return e;
    }), 201);
  })
  .get("/reports/alerts", requirePermission("reports.view"), async (c) =>
    c.json(await withTenant(c.get("sql"), c.get("auth").bid, async (tx) => ({
      low_stock: await tx`SELECT * FROM (${lowStock(tx)}) x ORDER BY x.on_hand - x.reorder_level LIMIT 20`,
      overdue: await tx`SELECT d.id, d.number, d.due_date, d.total_cents - d.paid_cents AS balance_cents, cu.name AS customer_name, cu.phone AS customer_phone
        FROM documents d LEFT JOIN customers cu ON cu.id = d.customer_id
        WHERE d.type IN ('INVOICE','SALE') AND d.status IN ('UNPAID','PARTIAL') AND d.due_date < (now() AT TIME ZONE 'Africa/Nairobi')::date
        ORDER BY d.due_date LIMIT 20`,
      pending_adjustments: (await tx`SELECT count(*)::int AS n FROM stock_adjustments WHERE status = 'PENDING'`)[0]!.n,
      open_shifts: (await tx`SELECT count(*)::int AS n FROM shifts WHERE status = 'OPEN'`)[0]!.n,
    }))));
