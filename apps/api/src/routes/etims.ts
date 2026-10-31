import { Hono } from "hono";
import { requireAuth, requirePermission } from "../auth";
import { withTenant } from "../db";
import type { AppEnv } from "../env";

/**
 * Prototype eTIMS view. Nothing is sent to KRA yet: every fiscal document is reported as PENDING
 * until a real OSCU/VSCU integration exists. VAT figures are real and net of credit notes.
 */
const nairobiMonth = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 7);
const periodOf = (q?: string) => (q && /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : nairobiMonth());

export const etimsRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/etims/summary", requirePermission("reports.view"), async (c) => {
    const period = periodOf(c.req.query("period"));
    return c.json(await withTenant(c.get("sql"), c.get("auth").bid, async (tx) => {
      const [v] = await tx`
        SELECT
          coalesce(sum(l.tax_cents * s.sign), 0) AS vat,
          coalesce(sum(l.net_cents * s.sign), 0) AS taxable,
          coalesce(sum(l.net_cents * s.sign) FILTER (WHERE l.tax_code IN ('B','E')), 0) AS standard,
          coalesce(sum(l.net_cents * s.sign) FILTER (WHERE l.tax_code NOT IN ('B','E')), 0) AS other
        FROM document_lines l
        JOIN documents d ON d.id = l.document_id
        CROSS JOIN LATERAL (SELECT CASE WHEN d.type = 'CREDIT_NOTE' THEN -1 ELSE 1 END AS sign) s
        WHERE d.type IN ('INVOICE','SALE','CREDIT_NOTE') AND to_char(d.issue_date, 'YYYY-MM') = ${period}`;
      const [n] = await tx`SELECT count(*)::int AS n FROM documents WHERE type IN ('INVOICE','SALE','CREDIT_NOTE') AND to_char(issue_date, 'YYYY-MM') = ${period}`;
      return {
        period,
        connection: { status: "NOT_CONNECTED", message: "Prototype: eTIMS is not connected to KRA. Documents queue as pending and nothing is submitted." },
        vatSummary: {
          totalVatCents: Number(v!.vat),
          totalTaxableCents: Number(v!.taxable),
          standardRatedCents: Number(v!.standard),
          zeroOrExemptCents: Number(v!.other),
          totalInvoices: n!.n,
          submittedInvoices: 0,
          pendingInvoices: n!.n,
        },
      };
    }));
  })
  // Whole month, uncapped: the VAT CSV must match the summary totals.
  .get("/etims/invoices", requirePermission("reports.view"), async (c) => {
    const period = periodOf(c.req.query("period"));
    return c.json(await withTenant(c.get("sql"), c.get("auth").bid, async (tx) => {
      const docs = await tx`
        SELECT d.id, d.type, d.number, d.issue_date, d.net_cents, d.tax_cents, d.total_cents,
          cu.name AS customer_name, cu.kra_pin AS customer_kra_pin
        FROM documents d LEFT JOIN customers cu ON cu.id = d.customer_id
        WHERE d.type IN ('INVOICE','SALE','CREDIT_NOTE') AND to_char(d.issue_date, 'YYYY-MM') = ${period}
        ORDER BY d.created_at DESC`;
      return docs.map((d) => ({ ...d, cuInvoiceNumber: null, etimsStatus: "PENDING" }));
    }));
  });
