import type postgres from "postgres";

/**
 * Books check for one business (run inside withTenant): the invariants a restored backup or a live ledger must satisfy.
 * Each check returns the offending rows, capped at 20; an empty report means the books reconcile.
 * Filters by business explicitly too: the restore drill runs as a superuser, which bypasses RLS.
 */
export async function integrityReport(tx: postgres.TransactionSql, bid: string) {
  const checks = {
    // Stock on hand must equal the sum of its movements and the latest running balance.
    stock_balance: await tx`SELECT b.branch_id, b.product_id, b.on_hand, coalesce(m.total, 0) AS movements, m.last_balance
      FROM stock_balances b LEFT JOIN LATERAL (SELECT sum(quantity) AS total,
        (SELECT balance_after FROM stock_movements x WHERE x.branch_id = b.branch_id AND x.product_id = b.product_id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_balance
        FROM stock_movements s WHERE s.branch_id = b.branch_id AND s.product_id = b.product_id) m ON true
      WHERE b.business_id = ${bid} AND (b.on_hand <> coalesce(m.total, 0) OR (m.last_balance IS NOT NULL AND b.on_hand <> m.last_balance)) LIMIT 20`,
    // Document headers must equal the sum of their lines.
    document_totals: await tx`SELECT d.id, d.type, d.number, d.net_cents, d.tax_cents, d.total_cents, l.net, l.tax, l.total
      FROM documents d JOIN LATERAL (SELECT coalesce(sum(net_cents), 0) AS net, coalesce(sum(tax_cents), 0) AS tax, coalesce(sum(total_cents), 0) AS total
        FROM document_lines WHERE document_id = d.id) l ON true
      WHERE d.business_id = ${bid} AND (d.net_cents <> l.net OR d.tax_cents <> l.tax OR d.total_cents <> l.total) LIMIT 20`,
    // paid_cents must equal confirmed payments (refunds on credit notes count at face value).
    document_payments: await tx`SELECT d.id, d.type, d.number, d.paid_cents, p.confirmed
      FROM documents d JOIN LATERAL (SELECT coalesce(sum(amount_cents), 0) AS confirmed FROM payments WHERE document_id = d.id AND status = 'CONFIRMED') p ON true
      WHERE d.business_id = ${bid} AND d.type <> 'QUOTE' AND d.paid_cents <> p.confirmed LIMIT 20`,
    document_status: await tx`SELECT id, type, number, status, paid_cents, total_cents FROM documents WHERE business_id = ${bid} AND type IN ('INVOICE','SALE') AND status <> 'VOID'
      AND status <> CASE WHEN paid_cents >= total_cents THEN 'PAID' WHEN paid_cents > 0 THEN 'PARTIAL' ELSE 'UNPAID' END LIMIT 20`,
    // The tax ledger (S9) must match document VAT wherever it exists.
    tax_ledger: await tx`SELECT d.id, d.type, d.number, d.tax_cents, t.tax FROM documents d
      JOIN LATERAL (SELECT sum(tax_cents) AS tax FROM tax_records WHERE document_id = d.id) t ON t.tax IS NOT NULL
      WHERE d.business_id = ${bid} AND t.tax <> d.tax_cents LIMIT 20`,
  };
  const failed = Object.entries(checks).filter(([, rows]) => rows.length).map(([k]) => k);
  return { ok: failed.length === 0, failed, checks };
}
