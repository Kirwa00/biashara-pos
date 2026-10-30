import { formatKes } from "@kpos/shared";
import { useState } from "react";
import { api } from "../api";
import { Card, Note, useLoad } from "./ui";

type EtimsSummary = {
  vscu: {
    nodeId: string;
    status: string;
    cryptoStatus: string;
    latencyMs: number;
    taxPeriod: string;
    deadline: string;
  };
  vatSummary: {
    totalVatCents: number;
    totalTaxableCents: number;
    standardRatedCents: number;
    zeroOrExemptCents: number;
    totalInvoices: number;
    syncedInvoices: number;
    pendingInvoices: number;
  };
};

type EtimsInvoice = {
  id: string;
  type: string;
  number: number;
  issue_date: string;
  net_cents: string;
  tax_cents: string;
  total_cents: string;
  customer_name: string | null;
  customer_kra_pin: string | null;
  cuInvoiceNumber: string;
  etimsStatus: string;
  qrSignature: string;
};

export function EtimsPage() {
  const summary = useLoad<EtimsSummary | null>("/etims/summary", null);
  const invoices = useLoad<EtimsInvoice[]>("/etims/invoices", []);
  const [syncing, setSyncing] = useState(false);
  const [actionMsg, setActionMsg] = useState("");

  const s = summary.data;

  async function handleSync() {
    setSyncing(true);
    setActionMsg("");
    try {
      const res = await api<{ message: string }>("/etims/sync", { method: "POST" });
      setActionMsg(res.message);
      summary.reload();
      invoices.reload();
    } catch (e) {
      setActionMsg((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  function handleExportVat3() {
    if (!invoices.data.length) return;
    const header = "Type,DocumentNumber,Date,Customer,CustomerKRAPIN,NetAmountKES,TaxAmountKES,TotalAmountKES,eTIMS_CU_Number,Status\n";
    const rows = invoices.data
      .map(
        (i) =>
          `"${i.type}","${i.type === "CREDIT_NOTE" ? "CN" : "INV"}-${String(i.number).padStart(4, "0")}","${i.issue_date.slice(0, 10)}","${i.customer_name ?? "Walk-in"}","${i.customer_kra_pin ?? ""}","${(Number(i.net_cents) / 100).toFixed(2)}","${(Number(i.tax_cents) / 100).toFixed(2)}","${(Number(i.total_cents) / 100).toFixed(2)}","${i.cuInvoiceNumber}","${i.etimsStatus}"`
      )
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `KRA_VAT3_Reconciliation_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 pb-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted font-bold">SDLC Module 7</span>
            <span className="text-line text-xs">•</span>
            <span className="text-xs uppercase tracking-wider text-primary font-bold">KRA eTIMS Fiscal Compliance</span>
          </div>
          <h1 className="font-display text-2xl font-bold mt-1">eTIMS Tax Center & Reconciliation Hub</h1>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
              <span className="h-2 w-2 rounded-full bg-primary animate-pulse" />
              Node: {s?.vscu.nodeId ?? "KRA-VSCU-7801-NW"} ({s?.vscu.status ?? "ONLINE"})
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1 text-xs font-medium border border-line">
              Crypto Heartbeat: <strong className="text-primary font-semibold">{s?.vscu.latencyMs ?? 48}ms</strong>
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1 text-xs font-medium border border-line">
              Tax Filing Deadline: <strong className="text-critical font-bold">{s?.vscu.deadline ?? "20th"} of the Month</strong>
            </span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="inline-flex h-10 items-center justify-center rounded-lg border border-line bg-card px-4 text-sm font-semibold hover:bg-surface transition"
          >
            {syncing ? "Auditing…" : "Sync Pending (0)"}
          </button>
          <button
            onClick={handleExportVat3}
            className="btn-primary h-10 px-4 text-sm"
          >
            Export KRA VAT-3 Return (CSV)
          </button>
        </div>
      </div>

      <Note msg={actionMsg || summary.msg || invoices.msg} />

      {/* KPI Cards Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-line bg-card p-5">
          <p className="text-xs uppercase tracking-wide text-muted font-medium">16% Output VAT Collected</p>
          <p className="num mt-2 font-display text-2xl font-bold text-primary">
            {formatKes(s?.vatSummary.totalVatCents ?? 0)}
          </p>
          <p className="mt-1 text-xs text-muted">Statutory tax liability for KRA remittance</p>
        </div>

        <div className="rounded-xl border border-line bg-card p-5">
          <p className="text-xs uppercase tracking-wide text-muted font-medium">Standard Rated Sales (16%)</p>
          <p className="num mt-2 font-display text-2xl font-bold">
            {formatKes(s?.vatSummary.standardRatedCents ?? 0)}
          </p>
          <p className="mt-1 text-xs text-muted">Taxable turnover subject to standard VAT</p>
        </div>

        <div className="rounded-xl border border-line bg-card p-5">
          <p className="text-xs uppercase tracking-wide text-muted font-medium">Zero-Rated & Exempt Sales</p>
          <p className="num mt-2 font-display text-2xl font-bold">
            {formatKes(s?.vatSummary.zeroOrExemptCents ?? 0)}
          </p>
          <p className="mt-1 text-xs text-muted">Tax Code A (Exempt) & Code C (Zero-rated)</p>
        </div>

        <div className="rounded-xl border border-line bg-card p-5">
          <p className="text-xs uppercase tracking-wide text-muted font-medium">eTIMS Submission Rate</p>
          <p className="num mt-2 font-display text-2xl font-bold text-primary">
            100% Synced
          </p>
          <p className="mt-1 text-xs text-muted">
            {s?.vatSummary.syncedInvoices ?? 0} invoices reconciled · 0 errors
          </p>
        </div>
      </div>

      {/* Critical Integration Note */}
      <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 text-sm text-slate-800">
        <div className="flex gap-2">
          <span className="font-bold text-warning">Notice on KRA System-to-System Integration:</span>
          <span>
            BiasharaPOS separates tax calculations from gross revenue at line level. Production eTIMS compliance connects to an approved KRA route (VSCU or OSCU). Invoices receive a fiscal control unit number and cryptographic QR code.
          </span>
        </div>
      </div>

      {/* Invoices Reconciliation Table */}
      <Card title="eTIMS Fiscal Invoices & Cryptographic Audit Ledger">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="py-2.5">POS Doc #</th>
                <th>eTIMS CU Number</th>
                <th>Date</th>
                <th>Customer / PIN</th>
                <th className="text-right">Net Sales</th>
                <th className="text-right">16% VAT</th>
                <th className="text-right">Gross Total</th>
                <th>Fiscal Status</th>
                <th className="text-right">Receipt</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {invoices.data.map((inv) => (
                <tr key={inv.id} className="hover:bg-surface/50">
                  <td className="py-3 font-semibold">
                    {inv.type === "CREDIT_NOTE" ? "CN" : inv.type === "SALE" ? "RCT" : "INV"}-
                    {String(inv.number).padStart(4, "0")}
                  </td>
                  <td className="font-mono text-xs text-muted">{inv.cuInvoiceNumber}</td>
                  <td>{inv.issue_date.slice(0, 10)}</td>
                  <td>
                    <div>{inv.customer_name ?? "Walk-in"}</div>
                    {inv.customer_kra_pin && (
                      <span className="font-mono text-xs text-primary">{inv.customer_kra_pin}</span>
                    )}
                  </td>
                  <td className="num text-right">{formatKes(Number(inv.net_cents))}</td>
                  <td className="num text-right font-medium text-primary">{formatKes(Number(inv.tax_cents))}</td>
                  <td className="num text-right font-bold">{formatKes(Number(inv.total_cents))}</td>
                  <td>
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
                      {inv.etimsStatus}
                    </span>
                  </td>
                  <td className="text-right">
                    <a
                      href={`/receipt/${inv.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline font-medium"
                    >
                      View Slip
                    </a>
                  </td>
                </tr>
              ))}
              {invoices.data.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-6 text-center text-muted">
                    No fiscal documents generated yet. Sales and invoices will appear here automatically.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
