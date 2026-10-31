import { formatKes } from "@kpos/shared";
import { useState } from "react";
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

const docNo = (i: { type: string; number: number }) => `${i.type === "CREDIT_NOTE" ? "CN" : i.type === "SALE" ? "RCT" : "INV"}-${String(i.number).padStart(4, "0")}`;
/** Quote a CSV cell and neutralise spreadsheet formulas. */
const cell = (v: string) => `"${v.replace(/"/g, '""').replace(/^([=+\-@\t\r])/, "'$1")}"`;
const thisMonth = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 7);

/** Prototype: shows real VAT figures; KRA submission is not connected, so every document is Pending. */
export function EtimsPage() {
  const [period, setPeriod] = useState(thisMonth());
  const summary = useLoad<EtimsSummary | null>(`/etims/summary?period=${period}`, null);
  const invoices = useLoad<EtimsInvoice[]>(`/etims/invoices?period=${period}`, []);
  const s = summary.data;
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
          <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">
            <span className="h-2 w-2 rounded-full bg-amber-500" /> KRA eTIMS: not connected (prototype)
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} className="input h-10" />
          <button onClick={exportCsv} disabled={!invoices.data.length} className="btn-primary h-10 px-4 text-sm">Export VAT CSV</button>
        </div>
      </div>

      <Note msg={summary.msg || invoices.msg} />
      <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 text-sm">
        {s?.connection.message ?? "eTIMS is not connected to KRA."} Use these figures to prepare your VAT return; they are not KRA-validated.
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
              {invoices.data.map((i) => (
                <tr key={i.id}>
                  <td className="py-3 font-semibold">{docNo(i)}</td>
                  <td>{i.issue_date.slice(0, 10)}</td>
                  <td><div>{i.customer_name ?? "Walk-in"}</div>{i.customer_kra_pin && <span className="font-mono text-xs text-primary">{i.customer_kra_pin}</span>}</td>
                  <td className="num text-right">{formatKes(sign(i) * Number(i.net_cents))}</td>
                  <td className="num text-right">{formatKes(sign(i) * Number(i.tax_cents))}</td>
                  <td className="num text-right font-bold">{formatKes(sign(i) * Number(i.total_cents))}</td>
                  <td><span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800">{i.etimsStatus}</span></td>
                  <td className="text-right"><a href={`/receipt/${i.id}`} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">View</a></td>
                </tr>
              ))}
              {!invoices.data.length && <tr><td colSpan={8} className="py-6 text-center text-muted">No sales, invoices or credit notes in {period}.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
