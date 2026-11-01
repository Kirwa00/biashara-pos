import { formatKes, NOTIFICATION_LABELS, type NotificationKind } from "@kpos/shared";
import type postgres from "postgres";
import { audit, withTenant } from "./db";
import type { Env } from "./env";
import { lowStock } from "./routes/reports";

export type Job = "morning" | "evening";
/** Cron expressions in wrangler.toml (UTC) → job. 05:00 UTC = 08:00 EAT, 17:00 UTC = 20:00 EAT. */
export const CRON_JOBS: Record<string, Job> = { "0 5 * * *": "morning", "0 17 * * *": "evening" };

type Draft = { kind: NotificationKind; title: string; body: string; data: Record<string, unknown> };
const kes = (c: unknown) => formatKes(Number(c));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export const nairobiDate = (now: Date) => new Date(now.getTime() + 3 * 3600_000).toISOString().slice(0, 10);

/** M-Pesa prompts that failed since the previous run (12 h apart) or are still waiting after 10 minutes. */
async function paymentIssues(tx: postgres.TransactionSql, now: string): Promise<Draft[]> {
  const rows = await tx`SELECT status, count(*)::int AS n, coalesce(sum(amount_cents), 0) AS amount_cents FROM payments
    WHERE (status = 'FAILED' AND created_at > ${now}::timestamptz - interval '12 hours') OR (status = 'PENDING' AND created_at < ${now}::timestamptz - interval '10 minutes')
    GROUP BY status`;
  if (!rows.length) return [];
  const by = Object.fromEntries(rows.map((r) => [r.status, r]));
  const parts = [by.FAILED && `${plural(by.FAILED.n, "payment")} failed (${kes(by.FAILED.amount_cents)})`, by.PENDING && `${plural(by.PENDING.n, "payment")} still pending (${kes(by.PENDING.amount_cents)})`].filter(Boolean);
  return [{ kind: "PAYMENT_ISSUES", title: "M-Pesa payments need attention", body: `${parts.join("; ")}. Check the invoices before handing over goods.`,
    data: { failed: by.FAILED?.n ?? 0, failed_cents: String(by.FAILED?.amount_cents ?? 0), pending: by.PENDING?.n ?? 0, pending_cents: String(by.PENDING?.amount_cents ?? 0) } }];
}

async function morning(tx: postgres.TransactionSql, day: string, now: string): Promise<Draft[]> {
  const out: Draft[] = [];
  const low = await tx`SELECT * FROM (${lowStock(tx)}) x ORDER BY x.on_hand - x.reorder_level, x.name`;
  if (low.length) out.push({ kind: "LOW_STOCK", title: `${plural(low.length, "product")} at or below reorder level`,
    body: low.slice(0, 5).map((p) => `${p.name}: ${Number(p.on_hand)} left (reorder at ${Number(p.reorder_level)})`).join("\n") + (low.length > 5 ? `\n…and ${low.length - 5} more` : ""),
    data: { count: low.length, items: low.slice(0, 20).map((p) => ({ id: p.id, sku: p.sku, name: p.name, on_hand: p.on_hand, reorder_level: p.reorder_level })) } });
  const [od] = await tx`SELECT count(*)::int AS invoices, count(DISTINCT customer_id)::int AS customers, coalesce(sum(total_cents - paid_cents), 0) AS overdue_cents
    FROM documents WHERE type IN ('INVOICE','SALE') AND status IN ('UNPAID','PARTIAL') AND due_date < ${day}`;
  if (od!.invoices) out.push({ kind: "OVERDUE_INVOICES", title: `${kes(od!.overdue_cents)} overdue`,
    body: `${plural(od!.invoices, "invoice")} from ${plural(od!.customers, "customer")} are past due. Send reminders from Payment Reminders.`,
    data: { invoices: od!.invoices, customers: od!.customers, overdue_cents: String(od!.overdue_cents) } });
  out.push(...await paymentIssues(tx, now));
  const [po] = await tx`SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS approval, coalesce(sum(total_cents) FILTER (WHERE status = 'PENDING'), 0) AS approval_cents,
    count(*) FILTER (WHERE status IN ('APPROVED','PARTIAL'))::int AS delivery FROM purchase_orders`;
  if (po!.approval || po!.delivery) out.push({ kind: "PO_ACTION", title: "Purchase orders awaiting action",
    body: [po!.approval && `${plural(po!.approval, "order")} awaiting approval (${kes(po!.approval_cents)})`, po!.delivery && `${plural(po!.delivery, "order")} awaiting delivery`].filter(Boolean).join("; ") + ".",
    data: { awaiting_approval: po!.approval, approval_cents: String(po!.approval_cents), awaiting_delivery: po!.delivery } });
  return out;
}

/** Owner's end-of-day numbers for the Nairobi date: sales earned, profit, and cash actually received. */
async function evening(tx: postgres.TransactionSql, day: string, now: string): Promise<Draft[]> {
  const [s] = await tx`SELECT (SELECT count(*)::int FROM documents WHERE type IN ('INVOICE','SALE') AND issue_date = ${day}) AS sales,
      (SELECT coalesce(sum(total_cents), 0) FROM documents WHERE type IN ('INVOICE','SALE') AND issue_date = ${day}) AS gross_cents,
      (SELECT coalesce(sum(total_cents), 0) FROM documents WHERE type = 'CREDIT_NOTE' AND issue_date = ${day}) AS returns_cents,
      coalesce(sum(l.net_cents * sg.s), 0) AS net_cents, coalesce(sum((l.net_cents - round(l.unit_cost_cents * l.quantity)) * sg.s), 0) AS profit_cents
    FROM documents d JOIN document_lines l ON l.document_id = d.id CROSS JOIN LATERAL (SELECT CASE WHEN d.type = 'CREDIT_NOTE' THEN -1 ELSE 1 END AS s) sg
    WHERE d.type IN ('INVOICE','SALE','CREDIT_NOTE') AND d.issue_date = ${day}`;
  const received = await tx`SELECT method, sum(amount_cents * direction) AS amount_cents FROM payments
    WHERE status = 'CONFIRMED' AND (created_at AT TIME ZONE 'Africa/Nairobi')::date = ${day} GROUP BY method ORDER BY method`;
  const [e] = await tx`SELECT coalesce(sum(amount_cents), 0) AS expenses_cents FROM expenses WHERE expense_date = ${day}`;
  const cash = received.reduce((t, r) => t + Number(r.amount_cents), 0);
  const out = await paymentIssues(tx, now);
  if (!s!.sales && !Number(s!.returns_cents) && !received.length && !Number(e!.expenses_cents)) return out;
  const net_profit = Number(s!.profit_cents) - Number(e!.expenses_cents);
  out.unshift({ kind: "DAILY_SUMMARY", title: `Today: ${kes(s!.gross_cents)} sales, ${kes(cash)} received`,
    body: [`Sales: ${kes(s!.gross_cents)} (${plural(s!.sales, "sale")})`, Number(s!.returns_cents) ? `Returns: ${kes(s!.returns_cents)}` : "",
      `Net sales (ex VAT): ${kes(s!.net_cents)}`, `Gross profit: ${kes(s!.profit_cents)}`, `Expenses: ${kes(e!.expenses_cents)}`, `Net profit: ${kes(net_profit)}`,
      `Received: ${kes(cash)}${received.length ? ` (${received.map((r) => `${r.method} ${kes(r.amount_cents)}`).join(", ")})` : ""}`].filter(Boolean).join("\n"),
    data: { date: day, sales: s!.sales, gross_cents: String(s!.gross_cents), returns_cents: String(s!.returns_cents), net_sales_cents: String(s!.net_cents),
      gross_profit_cents: String(s!.profit_cents), expenses_cents: String(e!.expenses_cents), net_profit_cents: String(net_profit), received_cents: String(cash),
      received: received.map((r) => ({ method: r.method, amount_cents: String(r.amount_cents) })) } });
  return out;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Emails a business's unsent notifications to its active owners in one message; rows stay locked while sending so overlapping runs can't double-send. */
export async function emailPending(env: Env, sql: postgres.Sql, bid: string) {
  return withTenant(sql, bid, async (tx) => {
    const rows = await tx`SELECT id, kind, title, body FROM notifications WHERE email_status IN ('PENDING','FAILED') AND email_attempts < 3
      AND created_at > now() - interval '2 days' ORDER BY created_at, kind FOR UPDATE SKIP LOCKED`;
    if (!rows.length) return 0;
    const ids = rows.map((r) => r.id as string);
    const owners = (await tx`SELECT email FROM users WHERE role = 'OWNER' AND is_active`).map((u) => u.email as string);
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !owners.length) {
      await tx`UPDATE notifications SET email_status = 'SKIPPED' WHERE id IN ${tx(ids)}`;
      return 0;
    }
    const [biz] = await tx`SELECT name FROM businesses`;
    const subject = rows.length === 1 ? `${biz!.name}: ${rows[0]!.title}` : `${biz!.name}: ${plural(rows.length, "alert")}`;
    const html = rows.map((r) => `<h3 style="margin:16px 0 4px">${esc(NOTIFICATION_LABELS[r.kind as NotificationKind])}: ${esc(r.title)}</h3><p style="margin:0">${esc(r.body).replace(/\n/g, "<br>")}</p>`).join("");
    const text = rows.map((r) => `${r.title}\n${r.body}`).join("\n\n");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": await sha256(ids.join(",")) },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: owners, subject, html: `<div style="font-family:sans-serif">${html}</div>`, text }),
    }).catch(() => null);
    const sent = !!res?.ok;
    await tx`UPDATE notifications SET email_status = ${sent ? "SENT" : "FAILED"}, email_attempts = email_attempts + 1, emailed_at = ${sent ? tx`now()` : tx`emailed_at`}
      WHERE id IN ${tx(ids)}`;
    await audit(tx, { businessId: bid, action: sent ? "notification.email.sent" : "notification.email.failed", entity: "notification", after: { ids, to: owners.length, status: res?.status ?? null } });
    return sent ? rows.length : 0;
  });
}

/** Runs one scheduled job for every active business (or just `businessIds`). Re-running for the same Nairobi day creates and sends nothing new. */
export async function runJob(env: Env, sql: postgres.Sql, job: Job, opts: { now?: Date; businessIds?: string[] } = {}) {
  const now = opts.now ?? new Date();
  const day = nairobiDate(now);
  const ids = opts.businessIds ?? (await sql`SELECT id FROM job_business_ids()`).map((r) => r.id as string);
  const result = { businesses: ids.length, created: 0, emailed: 0, failed: 0 };
  for (const bid of ids) {
    try {
      result.created += await withTenant(sql, bid, async (tx) => {
        let n = 0;
        for (const d of await (job === "morning" ? morning : evening)(tx, day, now.toISOString())) {
          const [row] = await tx`INSERT INTO notifications (business_id, kind, title, body, data, dedupe_key)
            VALUES (${bid}, ${d.kind}, ${d.title}, ${d.body}, ${tx.json(d.data as never)}, ${`${job}:${day}:${d.kind}`})
            ON CONFLICT (business_id, dedupe_key) DO NOTHING RETURNING id`;
          if (!row) continue;
          n++;
          await audit(tx, { businessId: bid, action: "notification.create", entity: "notification", entityId: row.id, after: { kind: d.kind, job, day } });
        }
        return n;
      });
      result.emailed += await emailPending(env, sql, bid);
    } catch (err) {
      result.failed++;
      console.error(`job ${job} failed for business ${bid}`, err);
    }
  }
  return result;
}
