import { TAX_CODES, type TaxCode } from "@kpos/shared";
import type postgres from "postgres";
import { decryptSecret } from "./crypto";
import { withTenant } from "./db";
import type { Env } from "./env";
import { nextNumber } from "./routes/documents";

type Tx = postgres.TransactionSql;
const TAX = Object.keys(TAX_CODES) as TaxCode[];
const MAX_ATTEMPTS = 8;

/** Writes the document's tax ledger rows and queues it for eTIMS. Call inside the transaction that posts the document. */
export async function recordFiscal(tx: Tx, bid: string, documentId: string) {
  const groups = await tx`SELECT l.tax_code, CASE WHEN d.type = 'CREDIT_NOTE' THEN -1 ELSE 1 END AS sign, sum(l.net_cents) AS taxable, sum(l.tax_cents) AS tax, d.issue_date::text AS issue_date
    FROM documents d JOIN document_lines l ON l.document_id = d.id WHERE d.id = ${documentId} GROUP BY l.tax_code, d.type, d.issue_date`;
  // Append-only ledger: the app role may insert tax records but never change them.
  for (const g of groups)
    await tx`INSERT INTO tax_records (business_id, document_id, tax_code, rate_bp, sign, taxable_cents, tax_cents, issue_date)
      VALUES (${bid}, ${documentId}, ${g.tax_code}, ${TAX_CODES[g.tax_code as TaxCode]?.rateBp ?? 0}, ${g.sign}, ${g.taxable}, ${g.tax}, ${g.issue_date})`;
  await tx`INSERT INTO etims_submissions (business_id, document_id, invc_no) VALUES (${bid}, ${documentId}, ${await nextNumber(tx, bid, "ETIMS")})`;
}

export type EtimsResult = { ok: true; rcptNo: string; rcptSign: string; internalData: string } | { ok: false; retryable: boolean; error: string };
export interface EtimsAdapter { saveSales(payload: Record<string, unknown>): Promise<EtimsResult> }

/** KRA defaults; override with ETIMS_BASE_URL. Verify both against KRA's current OSCU documentation before go-live. */
const OSCU_URLS = { SANDBOX: "https://etims-api-sbx.kra.go.ke/etims-api", PRODUCTION: "https://etims-api.kra.go.ke/etims-api" } as const;

/** OSCU (online sales control unit) over HTTPS: every call carries the device's tin, bhfId and cmcKey headers. */
export class OscuAdapter implements EtimsAdapter {
  constructor(private base: string, private headers: { tin: string; bhfId: string; cmcKey: string }) {}
  async saveSales(payload: Record<string, unknown>): Promise<EtimsResult> {
    const res = await fetch(`${this.base}/trnsSales/saveSales`, { method: "POST", headers: { "content-type": "application/json", ...this.headers }, body: JSON.stringify(payload) }).catch(() => null);
    if (!res) return { ok: false, retryable: true, error: "KRA eTIMS unreachable" };
    if (res.status >= 500 || res.status === 429) return { ok: false, retryable: true, error: `KRA eTIMS HTTP ${res.status}` };
    const body = (await res.json().catch(() => null)) as { resultCd?: string; resultMsg?: string; data?: { curRcptNo?: number | string; rcptSign?: string; intrlData?: string } } | null;
    if (body?.resultCd === "000" && body.data) return { ok: true, rcptNo: String(body.data.curRcptNo ?? ""), rcptSign: body.data.rcptSign ?? "", internalData: body.data.intrlData ?? "" };
    return { ok: false, retryable: !body, error: body ? `KRA ${body.resultCd}: ${body.resultMsg ?? "rejected"}` : `KRA eTIMS HTTP ${res.status}` };
  }
}

const kes = (c: unknown) => Number(c) / 100;
const ymd = (d: Date | string) => new Date(d).toISOString().slice(0, 10).replace(/-/g, "");
const stamp = (d: Date | string) => new Date(new Date(d).getTime() + 3 * 3600_000).toISOString().slice(0, 19).replace(/[-T:]/g, "");

/** Builds the OSCU saveSales body from the posted document. Throws a readable error when products lack KRA codes. */
export async function buildSalesPayload(tx: Tx, sub: postgres.Row) {
  const [d] = await tx`SELECT d.*, cu.name AS customer_name, cu.kra_pin AS customer_pin, src_s.invc_no AS original_invc_no, u.name AS user_name
    FROM documents d LEFT JOIN customers cu ON cu.id = d.customer_id JOIN users u ON u.id = d.created_by
    LEFT JOIN etims_submissions src_s ON src_s.document_id = d.source_id AND d.type = 'CREDIT_NOTE'
    WHERE d.id = ${sub.document_id} ORDER BY src_s.created_at LIMIT 1`;
  const lines = await tx`SELECT l.*, p.sku, p.barcode, p.etims_item_code, p.kra_item_class_code, p.kra_unit_code, p.kra_pkg_unit_code
    FROM document_lines l JOIN products p ON p.id = l.product_id WHERE l.document_id = ${sub.document_id} ORDER BY l.id`;
  const unmapped = [...new Set(lines.filter((l) => !l.etims_item_code || !l.kra_item_class_code).map((l) => l.description as string))];
  if (unmapped.length) throw new Error(`Map KRA item codes for: ${unmapped.join(", ")}`);
  const pay = (await tx`SELECT method FROM payments WHERE document_id = ${sub.document_id} AND status = 'CONFIRMED' ORDER BY created_at LIMIT 1`)[0]?.method;
  const per = Object.fromEntries(TAX.map((c) => [c, { taxable: 0, tax: 0 }]));
  for (const l of lines) { per[l.tax_code]!.taxable += Number(l.total_cents); per[l.tax_code]!.tax += Number(l.tax_cents); }
  const refund = d!.type === "CREDIT_NOTE";
  return {
    invcNo: sub.invc_no, orgInvcNo: refund ? (d!.original_invc_no ?? 0) : 0,
    custTin: d!.customer_pin ?? null, custNm: d!.customer_name ?? null,
    salesTyCd: "N", rcptTyCd: refund ? "R" : "S", pmtTyCd: pay === "CASH" ? "01" : pay === "MPESA" ? "06" : pay === "CARD" ? "05" : pay === "BANK" ? "04" : "02",
    salesSttsCd: "02", cfmDt: stamp(d!.created_at), salesDt: ymd(d!.issue_date), stockRlsDt: stamp(d!.created_at),
    cnclReqDt: null, cnclDt: null, rfdDt: refund ? stamp(d!.created_at) : null, rfdRsnCd: refund ? "06" : null,
    totItemCnt: lines.length,
    ...Object.fromEntries(TAX.flatMap((c) => [[`taxblAmt${c}`, kes(per[c]!.taxable)], [`taxRt${c}`, TAX_CODES[c].rateBp / 100], [`taxAmt${c}`, kes(per[c]!.tax)]])),
    totTaxblAmt: kes(d!.total_cents), totTaxAmt: kes(d!.tax_cents), totAmt: kes(d!.total_cents),
    prchrAcptcYn: "N", remark: null, regrId: String(d!.created_by).slice(0, 20), regrNm: d!.user_name, modrId: String(d!.created_by).slice(0, 20), modrNm: d!.user_name,
    receipt: { custTin: d!.customer_pin ?? null, rptNo: sub.invc_no, prchrAcptcYn: "N" },
    itemList: lines.map((l, i) => ({
      itemSeq: i + 1, itemCd: l.etims_item_code, itemClsCd: l.kra_item_class_code, itemNm: l.description, bcd: l.barcode ?? null,
      pkgUnitCd: l.kra_pkg_unit_code ?? "NT", pkg: Number(l.quantity), qtyUnitCd: l.kra_unit_code ?? "U", qty: Number(l.quantity),
      prc: kes(l.unit_price_cents), splyAmt: kes(l.total_cents), dcRt: 0, dcAmt: 0, isrccCd: null, isrccNm: null, isrcRt: null, isrcAmt: null,
      taxTyCd: l.tax_code, taxblAmt: kes(l.total_cents), taxAmt: kes(l.tax_cents), totAmt: kes(l.total_cents),
    })),
  };
}

const backoff = (attempts: number) => `${Math.min(15 * 2 ** attempts, 24 * 60)} minutes`;

/** Submits due documents for every business with eTIMS enabled. Each row is leased before the KRA call, so overlapping runs never submit it twice. */
export async function processEtimsQueue(env: Env, sql: postgres.Sql, opts: { businessIds?: string[]; adapter?: EtimsAdapter; limit?: number } = {}) {
  const ids = opts.businessIds ?? (await sql`SELECT id FROM job_business_ids()`).map((r) => r.id as string);
  const result = { businesses: 0, submitted: 0, failed: 0, dead: 0 };
  for (const bid of ids) {
    try {
      const [s] = await withTenant(sql, bid, (tx) => tx`SELECT * FROM etims_settings WHERE enabled`);
      if (!s) continue;
      result.businesses++;
      const adapter = opts.adapter ?? new OscuAdapter(env.ETIMS_BASE_URL ?? OSCU_URLS[s.environment as keyof typeof OSCU_URLS],
        { tin: s.tin, bhfId: s.bhf_id, cmcKey: await decryptSecret(env.ENCRYPTION_KEY ?? "", s.cmc_key_enc) });
      for (let i = 0; i < (opts.limit ?? 50); i++) {
        const claimed = await withTenant(sql, bid, async (tx) => {
          const [sub] = await tx`UPDATE etims_submissions SET next_attempt_at = now() + interval '10 minutes', updated_at = now()
            WHERE id = (SELECT id FROM etims_submissions WHERE status IN ('QUEUED','FAILED') AND next_attempt_at <= now()
              ORDER BY invc_no FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`;
          if (!sub) return null;
          try {
            return { sub, payload: await buildSalesPayload(tx, sub) };
          } catch (err) {
            return { sub, error: (err as Error).message };
          }
        });
        if (!claimed) break;
        const { sub } = claimed;
        const payload = "payload" in claimed ? claimed.payload : undefined;
        const r: EtimsResult = payload ? await adapter.saveSales(payload) : { ok: false, retryable: false, error: (claimed as { error: string }).error };
        await withTenant(sql, bid, async (tx) => {
          if (r.ok) {
            await tx`UPDATE etims_submissions SET status = 'SUBMITTED', attempts = attempts + 1, rcpt_no = ${r.rcptNo}, rcpt_sign = ${r.rcptSign}, internal_data = ${r.internalData},
              kra_taxable_cents = ${Math.round(payload!.totTaxblAmt * 100)}, kra_tax_cents = ${Math.round(payload!.totTaxAmt * 100)}, kra_total_cents = ${Math.round(payload!.totAmt * 100)},
              last_error = null, submitted_at = now(), updated_at = now() WHERE id = ${sub.id}`;
            result.submitted++;
          } else {
            const dead = r.retryable && sub.attempts + 1 >= MAX_ATTEMPTS;
            // Rejections and unmapped items wait 6 h (or a manual retry after fixing); outages back off exponentially.
            await tx`UPDATE etims_submissions SET status = ${dead ? "DEAD" : "FAILED"}, attempts = attempts + 1, last_error = ${r.error},
              next_attempt_at = now() + ${r.retryable ? backoff(sub.attempts) : "6 hours"}::interval, updated_at = now() WHERE id = ${sub.id}`;
            if (dead) result.dead++; else result.failed++;
          }
        });
      }
    } catch (err) {
      console.error(`etims queue failed for business ${bid}`, err);
    }
  }
  return result;
}

/** Period reconciliation: documents never accepted by KRA, receipts used twice, and amounts that differ from what was submitted or from the tax ledger. */
export async function reconcile(tx: Tx, period: string) {
  const docs = await tx`SELECT d.id, d.type, d.number, d.issue_date, d.total_cents, d.tax_cents,
      (SELECT count(*)::int FROM etims_submissions s WHERE s.document_id = d.id AND s.status = 'SUBMITTED') AS submitted,
      (SELECT row_to_json(s) FROM etims_submissions s WHERE s.document_id = d.id ORDER BY (s.status = 'SUBMITTED') DESC, s.created_at LIMIT 1) AS sub,
      (SELECT coalesce(sum(t.tax_cents), 0) FROM tax_records t WHERE t.document_id = d.id) AS ledger_tax,
      (SELECT count(*)::int FROM tax_records t WHERE t.document_id = d.id) AS ledger_rows
    FROM documents d WHERE d.type IN ('INVOICE','SALE','CREDIT_NOTE') AND to_char(d.issue_date, 'YYYY-MM') = ${period} ORDER BY d.issue_date, d.created_at`;
  const shared = await tx`SELECT rcpt_no, json_agg(DISTINCT document_id) AS docs FROM etims_submissions WHERE status = 'SUBMITTED' AND rcpt_no IS NOT NULL
    AND document_id IN (SELECT id FROM documents WHERE to_char(issue_date, 'YYYY-MM') = ${period}) GROUP BY rcpt_no HAVING count(DISTINCT document_id) > 1`;
  const sharedBy = new Map<string, string>();
  for (const r of shared) for (const id of r.docs as string[]) sharedBy.set(id, r.rcpt_no);
  type Issue = { type: "MISSING" | "DUPLICATE" | "MISMATCHED"; document_id: string; doc_type: string; number: number; detail: string };
  const issues: Issue[] = [];
  for (const d of docs) {
    const at = (type: Issue["type"], detail: string) => issues.push({ type, document_id: d.id, doc_type: d.type, number: d.number, detail });
    const s = d.sub as { status: string; last_error: string | null; kra_total_cents: number | null; kra_tax_cents: number | null } | null;
    if (!d.submitted) at("MISSING", s ? `eTIMS ${s.status.toLowerCase()}${s.last_error ? `: ${s.last_error}` : ""}` : "Never queued for eTIMS");
    if (d.submitted > 1) at("DUPLICATE", `Submitted ${d.submitted} times`);
    if (sharedBy.has(d.id)) at("DUPLICATE", `KRA receipt ${sharedBy.get(d.id)} is also on another document`);
    if (d.submitted && s && (Number(s.kra_total_cents) !== Number(d.total_cents) || Number(s.kra_tax_cents) !== Number(d.tax_cents)))
      at("MISMATCHED", `KRA has total ${Number(s.kra_total_cents) / 100} / VAT ${Number(s.kra_tax_cents) / 100}; books have ${Number(d.total_cents) / 100} / ${Number(d.tax_cents) / 100}`);
    if (!d.ledger_rows) at("MISMATCHED", "No tax record for this document");
    else if (Math.abs(Number(d.ledger_tax)) !== Number(d.tax_cents)) at("MISMATCHED", `Tax ledger VAT ${Number(d.ledger_tax) / 100} differs from document VAT ${Number(d.tax_cents) / 100}`);
  }
  const count = (t: Issue["type"]) => new Set(issues.filter((i) => i.type === t).map((i) => i.document_id)).size;
  return { period, documents: docs.length, submitted: docs.filter((d) => d.submitted).length, missing: count("MISSING"), duplicate: count("DUPLICATE"), mismatched: count("MISMATCHED"), issues };
}
