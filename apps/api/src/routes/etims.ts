import { etimsSettingsSchema, kraCodesSchema } from "@kpos/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth, requirePermission } from "../auth";
import { encryptSecret } from "../crypto";
import { audit, withTenant } from "../db";
import type { AppEnv } from "../env";
import { reconcile } from "../etims";
import { key } from "../payhero";

/** eTIMS (OSCU): device settings, KRA item codes, the submission queue and period reconciliation. VAT figures are net of credit notes. */
const nairobiMonth = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 7);
const periodOf = (q?: string) => (q && /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : nairobiMonth());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const etimsRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/settings/etims", requirePermission("settings.etims"), async (c) => {
    const [s] = await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`SELECT environment, tin, bhf_id, device_serial, enabled, updated_at FROM etims_settings`);
    return c.json(s ? { configured: true, environment: s.environment, tin: s.tin, bhfId: s.bhf_id, deviceSerial: s.device_serial, enabled: s.enabled, updatedAt: s.updated_at } : { configured: false });
  })
  .put("/settings/etims", requirePermission("settings.etims"), zValidator("json", etimsSettingsSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const b = c.req.valid("json");
    const enc = await encryptSecret(key(c.env), b.cmcKey);
    await withTenant(c.get("sql"), bid, async (tx) => {
      await tx`INSERT INTO etims_settings (business_id, environment, tin, bhf_id, device_serial, cmc_key_enc, enabled)
        VALUES (${bid}, ${b.environment}, ${b.tin}, ${b.bhfId}, ${b.deviceSerial}, ${enc}, ${b.enabled})
        ON CONFLICT (business_id) DO UPDATE SET environment = EXCLUDED.environment, tin = EXCLUDED.tin, bhf_id = EXCLUDED.bhf_id,
          device_serial = EXCLUDED.device_serial, cmc_key_enc = EXCLUDED.cmc_key_enc, enabled = EXCLUDED.enabled, updated_at = now()`;
      await audit(tx, { businessId: bid, userId: sub, action: "settings.etims.update", entity: "etims_settings", after: { environment: b.environment, tin: b.tin, bhfId: b.bhfId, deviceSerial: b.deviceSerial, enabled: b.enabled } });
    });
    return c.json({ configured: true, enabled: b.enabled });
  })
  .get("/etims/items", requirePermission("catalog.manage"), async (c) =>
    c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`SELECT id, sku, name, tax_code, etims_item_code, kra_item_class_code, kra_unit_code, kra_pkg_unit_code,
      (etims_item_code IS NOT NULL AND kra_item_class_code IS NOT NULL) AS mapped FROM products WHERE is_active ORDER BY mapped, name LIMIT 1000`)))
  .put("/etims/items/:id", requirePermission("catalog.manage"), zValidator("json", kraCodesSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const id = c.req.param("id");
    if (!UUID.test(id)) throw new HTTPException(404, { message: "Product not found" });
    const b = c.req.valid("json");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const [p] = await tx`UPDATE products SET etims_item_code = ${b.itemCode}, kra_item_class_code = ${b.itemClassCode}, kra_unit_code = ${b.unitCode}, kra_pkg_unit_code = ${b.pkgUnitCode}
        WHERE id = ${id} RETURNING id, sku, name, etims_item_code, kra_item_class_code, kra_unit_code, kra_pkg_unit_code`;
      if (!p) throw new HTTPException(404, { message: "Product not found" });
      await audit(tx, { businessId: bid, userId: sub, action: "product.kra_codes", entity: "product", entityId: id, after: b });
      return p;
    }));
  })
  .get("/etims/submissions", requirePermission("reports.view"), async (c) => {
    const status = c.req.query("status");
    return c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`SELECT s.id, s.document_id, s.invc_no, s.status, s.attempts, s.next_attempt_at, s.last_error, s.rcpt_no, s.submitted_at,
        d.type AS doc_type, d.number, d.total_cents FROM etims_submissions s JOIN documents d ON d.id = s.document_id
      ${status ? tx`WHERE s.status = ${status}` : tx``} ORDER BY s.invc_no DESC LIMIT 200`));
  })
  .post("/etims/submissions/:id/retry", requirePermission("settings.etims"), async (c) => {
    const { sub, bid } = c.get("auth");
    const id = c.req.param("id");
    if (!UUID.test(id)) throw new HTTPException(404, { message: "Submission not found" });
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const [s] = await tx`SELECT id, status FROM etims_submissions WHERE id = ${id} FOR UPDATE`;
      if (!s) throw new HTTPException(404, { message: "Submission not found" });
      if (!["FAILED", "DEAD"].includes(s.status)) throw new HTTPException(409, { message: `Only failed submissions can be retried (this one is ${s.status.toLowerCase()})` });
      const [r] = await tx`UPDATE etims_submissions SET status = 'QUEUED', attempts = 0, next_attempt_at = now(), updated_at = now() WHERE id = ${id} RETURNING id, status`;
      await audit(tx, { businessId: bid, userId: sub, action: "etims.retry", entity: "etims_submission", entityId: id, before: { status: s.status } });
      return r;
    }));
  })
  .get("/etims/reconciliation", requirePermission("reports.view"), async (c) =>
    c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => reconcile(tx, periodOf(c.req.query("period"))))))
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
      const [n] = await tx`SELECT count(*)::int AS n,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM etims_submissions s WHERE s.document_id = d.id AND s.status = 'SUBMITTED'))::int AS submitted
        FROM documents d WHERE d.type IN ('INVOICE','SALE','CREDIT_NOTE') AND to_char(d.issue_date, 'YYYY-MM') = ${period}`;
      const byCode = await tx`SELECT tax_code, rate_bp, sum(taxable_cents * sign) AS taxable_cents, sum(tax_cents * sign) AS tax_cents
        FROM tax_records WHERE to_char(issue_date, 'YYYY-MM') = ${period} GROUP BY tax_code, rate_bp ORDER BY tax_code`;
      const [s] = await tx`SELECT environment, enabled FROM etims_settings`;
      const connection = !s ? { status: "NOT_CONNECTED", message: "eTIMS is not set up. Add your OSCU device details in eTIMS settings; documents queue until then." }
        : !s.enabled ? { status: "DISABLED", message: `OSCU ${s.environment.toLowerCase()} device saved but submission is switched off; documents keep queueing.` }
        : { status: s.environment === "PRODUCTION" ? "CONNECTED" : "SANDBOX", message: `Submitting to KRA OSCU ${s.environment.toLowerCase()} every 15 minutes.` };
      return {
        period,
        connection,
        vatSummary: {
          totalVatCents: Number(v!.vat),
          totalTaxableCents: Number(v!.taxable),
          standardRatedCents: Number(v!.standard),
          zeroOrExemptCents: Number(v!.other),
          totalInvoices: n!.n,
          submittedInvoices: n!.submitted,
          pendingInvoices: n!.n - n!.submitted,
        },
        byTaxCode: byCode,
      };
    }));
  })
  // Whole month, uncapped: the VAT CSV must match the summary totals.
  .get("/etims/invoices", requirePermission("reports.view"), async (c) => {
    const period = periodOf(c.req.query("period"));
    return c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`
      SELECT d.id, d.type, d.number, d.issue_date, d.net_cents, d.tax_cents, d.total_cents,
        cu.name AS customer_name, cu.kra_pin AS customer_kra_pin, s.rcpt_no AS "cuInvoiceNumber", coalesce(s.status, 'NOT_QUEUED') AS "etimsStatus"
      FROM documents d LEFT JOIN customers cu ON cu.id = d.customer_id
      LEFT JOIN LATERAL (SELECT rcpt_no, status FROM etims_submissions WHERE document_id = d.id ORDER BY (status = 'SUBMITTED') DESC, created_at LIMIT 1) s ON true
      WHERE d.type IN ('INVOICE','SALE','CREDIT_NOTE') AND to_char(d.issue_date, 'YYYY-MM') = ${period}
      ORDER BY d.created_at DESC`));
  });
