import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth, requirePermission } from "../auth";
import { audit, withTenant } from "../db";
import type { AppEnv } from "../env";

// Users and payment settings are deliberately excluded: they hold password hashes and PayHero credentials.
const MAX_ROWS = 100_000;
const ENTITIES = ["products", "categories", "customers", "suppliers", "documents", "document_lines", "payments", "purchases", "purchase_lines", "stock_movements", "stock_balances", "shifts"];

const cell = (v: unknown): string => {
  if (v == null) return "";
  let s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`; // spreadsheet formula injection; plain numbers pass
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const exportRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/export/:entity", requirePermission("data.export"), async (c) => {
    const { sub, bid } = c.get("auth");
    const entity = c.req.param("entity");
    if (!ENTITIES.includes(entity)) throw new HTTPException(404, { message: "Unknown export" });
    const rows = await withTenant(c.get("sql"), bid, async (tx) => {
      const n = (await tx`SELECT count(*)::int AS n FROM ${tx(entity)}`)[0]!.n as number;
      if (n > MAX_ROWS) throw new HTTPException(413, { message: `Too many rows (${n}) for one CSV; contact support for a full backup` });
      const r = await tx`SELECT * FROM ${tx(entity)} ORDER BY 1`;
      await audit(tx, { businessId: bid, userId: sub, action: "data.export", entity, after: { rows: r.length } });
      return r;
    });
    const cols = rows.columns.map((col) => col.name);
    const body = [cols.join(","), ...rows.map((r) => cols.map((k) => cell(r[k])).join(","))].join("\n") + "\n";
    return c.body(body, 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${entity}.csv"` });
  });
