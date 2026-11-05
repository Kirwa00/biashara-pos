import { formatKes } from "@kpos/shared";
import { useState } from "react";
import { api } from "../api";
import { EtimsItemCodes, EtimsSettingsCard } from "./EtimsSetup";
import { Card, Note, useLoad } from "./ui";

type EtimsSummary = {
  period: string;
  connection: { status: string; message: string };
  vatSummary: { totalVatCents: number; totalTaxableCents: number; standardRatedCents: number; zeroOrExemptCents: number; totalInvoices: number; submittedInvoices: number; pendingInvoices: number };
};
type EtimsInvoice = {
  id: string; type: string; number: number; issue_date: string; net_cents: string; tax_cents: string; total_cents: string;
  customer_name: string | null; customer_kra_pin: string | null; cuInvoiceNumber: string | null; etimsStatus: string;
};
type Reconciliation = { documents: number; submitted: number; missing: number; duplicate: number; mismatched: number; issues: { type: string; document_id: string; doc_type: string; number: number; detail: string }[] };
type Submission = { id: string; invc_no: number; status: string; attempts: number; last_error: string | null; next_attempt_at: string; doc_type: string; number: number };
const STATUS_TONE: Record<string, string> = { SUBMITTED: "bg-emerald-50 text-emerald-700", QUEUED: "bg-amber-50 text-amber-800", FAILED: "bg-red-50 text-critical", DEAD: "bg-red-100 text-critical", NOT_QUEUED: "bg-surface text-muted" };
const CONN_TONE: Record<string, string> = { CONNECTED: "bg-emerald-50 text-emerald-700", SANDBOX: "bg-sky-50 text-sky-700", DISABLED: "bg-amber-50 text-amber-800", NOT_CONNECTED: "bg-amber-50 text-amber-800" };

const docNo = (i: { type: string; number: number }) => `${i.type === "CREDIT_NOTE" ? "CN" : i.type === "SALE" ? "RCT" : "INV"}-${String(i.number).padStart(4, "0")}`;
/** Quote a CSV cell and neutralise spreadsheet formulas. */
const cell = (v: string) => `"${v.replace(/"/g, '""').replace(/^([=+\-@\t\r])/, "'$1")}"`;
const thisMonth = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 7);

/** VAT figures, eTIMS submission status, reconciliation and setup. Documents queue for KRA OSCU and are sent every 15 minutes once enabled. */
export function EtimsPage() {
  const [period, setPeriod] = useState(thisMonth());
  const summary = useLoad<EtimsSummary | null>(`/etims/summary?period=${period}`, null);
  const invoices = useLoad<EtimsInvoice[]>(`/etims/invoices?period=${period}`, []);
  const rec = useLoad<Reconciliation | null>(`/etims/reconciliation?period=${period}`, null);
  const failed = useLoad<Submission[]>("/etims/submissions?status=FAILED", []);
  const dead = useLoad<Submission[]>("/etims/submissions?status=DEAD", []);
  const [msg, setMsg] = useState("");
  const s = summary.data;
  const retry = async (id: string) => {
    try {
      await api(`/etims/submissions/${id}/retry`, { method: "POST", body: "{}" });
      setMsg("Queued for the next eTIMS run (within 15 minutes).");
      failed.reload(); dead.reload(); invoices.reload();
    } catch (e) { setMsg((e as Error).message); }
  };
  const sign = (i: EtimsInvoice) => (i.type === "CREDIT_NOTE" ? -1 : 1);

  function exportCsv() {
    const rows = invoices.data.map((i) => [i.type, docNo(i), i.issue_date.slice(0, 10), i.customer_name ?? "Walk-in", i.customer_kra_pin ?? "",
      ((sign(i) * Number(i.net_cents)) / 100).toFixed(2), ((sign(i) * Number(i.tax_cents)) / 100).toFixed(2), ((sign(i) * Number(i.total_cents)) / 100).toFixed(2), i.etimsStatus].map(cell).join(","));
    const csv = ["Type,DocumentNumber,Date,Customer,CustomerKRAPIN,NetKES,VATKES,TotalKES,eTIMSStatus", ...rows].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    a.download = `VAT_${period}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const kpis = [
    ["Output VAT (net of credit notes)", s?.vatSummary.totalVatCents ?? 0],
    ["Standard-rated sales (net)", s?.vatSummary.standardRatedCents ?? 0],
    ["Zero-rated / exempt / non-VAT (net)", s?.vatSummary.zeroOrExemptCents ?? 0],
  ] as const;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold">eTIMS & VAT</h1>
          <span className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${CONN_TONE[s?.connection.status ?? "NOT_CONNECTED"]}`}>
            <span className="h-2 w-2 rounded-full bg-current" /> KRA eTIMS: {(s?.connection.status ?? "NOT_CONNECTED").replace("_", " ").toLowerCase()}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} className="input h-10" />
          <button onClick={exportCsv} disabled={!invoices.data.length} className="btn-primary h-10 px-4 text-sm">Export VAT CSV</button>
        </div>
      </div>

      <Note msg={msg || summary.msg || invoices.msg} />
      <div className="rounded-xl border border-line bg-card p-4 text-sm">
        {s?.connection.message ?? "eTIMS is not set up."} Figures marked submitted carry a KRA receipt number; anything else is not yet KRA-validated.
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map(([label, v]) => (
          <div key={label} className="rounded-xl border border-line bg-card p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
            <p className="num mt-2 font-display text-2xl font-bold">{formatKes(v)}</p>
          </div>
        ))}
        <div className="rounded-xl border border-line bg-card p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Sent to KRA</p>
          <p className="num mt-2 font-display text-2xl font-bold">{s?.vatSummary.submittedInvoices ?? 0} of {s?.vatSummary.totalInvoices ?? 0}</p>
          <p className="mt-1 text-xs text-muted">{s?.vatSummary.pendingInvoices ?? 0} pending</p>
        </div>
      </div>

      <Card title={`Fiscal documents — ${period}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-muted">
              <tr><th className="py-2.5">Doc #</th><th>Date</th><th>Customer / PIN</th><th className="text-right">Net</th><th className="text-right">VAT</th><th className="text-right">Total</th><th>eTIMS</th><th className="text-right">Receipt</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {invoices.data.slice(0, 200).map((i) => (
                <tr key={i.id}>
                  <td className="py-3 font-semibold">{docNo(i)}</td>
                  <td>{i.issue_date.slice(0, 10)}</td>
                  <td><div>{i.customer_name ?? "Walk-in"}</div>{i.customer_kra_pin && <span className="font-mono text-xs text-primary">{i.customer_kra_pin}</span>}</td>
                  <td className="num text-right">{formatKes(sign(i) * Number(i.net_cents))}</td>
                  <td className="num text-right">{formatKes(sign(i) * Number(i.tax_cents))}</td>
                  <td className="num text-right font-bold">{formatKes(sign(i) * Number(i.total_cents))}</td>
                  <td><span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_TONE[i.etimsStatus] ?? STATUS_TONE.QUEUED}`}>{i.etimsStatus.replace("_", " ")}</span>{i.cuInvoiceNumber && <span className="ml-1 font-mono text-xs text-muted">#{i.cuInvoiceNumber}</span>}</td>
                  <td className="text-right"><a href={`/receipt/${i.id}`} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">View</a></td>
                </tr>
              ))}
              {invoices.data.length > 200 && <tr><td colSpan={8} className="py-3 text-center text-muted">Showing the latest 200 of {invoices.data.length}; the CSV export includes all.</td></tr>}
              {!invoices.data.length && <tr><td colSpan={8} className="py-6 text-center text-muted">No sales, invoices or credit notes in {period}.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={`Reconciliation — ${period}`}>
        {rec.data && (
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {([["Accepted by KRA", `${rec.data.submitted} / ${rec.data.documents}`], ["Missing", rec.data.missing], ["Duplicate", rec.data.duplicate], ["Mismatched", rec.data.mismatched]] as const).map(([k, v]) => (
              <div key={k} className="rounded-lg bg-surface p-3"><p className="text-xs text-muted">{k}</p><p className="num font-display text-xl font-bold">{v}</p></div>
            ))}
          </div>
        )}
        <ul className="divide-y divide-line text-sm">
          {rec.data?.issues.map((i, n) => (
            <li key={n} className="flex gap-3 py-2">
              <span className={`h-fit rounded px-2 py-0.5 text-[11px] font-bold ${i.type === "MISSING" ? "bg-amber-50 text-amber-800" : "bg-red-50 text-critical"}`}>{i.type}</span>
              <span className="font-semibold">{docNo({ type: i.doc_type, number: i.number })}</span>
              <span className="text-muted">{i.detail}</span>
            </li>
          ))}
          {rec.data && !rec.data.issues.length && <li className="py-4 text-center text-muted">Books and KRA agree for {period}.</li>}
        </ul>
      </Card>

      {[...dead.data, ...failed.data].length > 0 && (
        <Card title="Failed submissions">
          <div className="overflow-x-auto"><table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-muted"><tr><th className="py-2">Doc #</th><th>KRA invoice no.</th><th>Status</th><th>Attempts</th><th>Last error</th><th /></tr></thead>
            <tbody className="divide-y divide-line">
              {[...dead.data, ...failed.data].map((x) => (
                <tr key={x.id}>
                  <td className="py-2 font-semibold">{docNo({ type: x.doc_type, number: x.number })}</td>
                  <td className="num">{x.invc_no}</td>
                  <td><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[x.status]}`}>{x.status}</span></td>
                  <td className="num">{x.attempts}</td>
                  <td className="text-xs text-muted">{x.last_error}</td>
                  <td className="text-right"><button onClick={() => retry(x.id)} className="text-xs font-semibold text-primary hover:underline">Retry now</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      )}

      <EtimsItemCodes />
      <EtimsSettingsCard onSaved={summary.reload} />
    </div>
  );
}
