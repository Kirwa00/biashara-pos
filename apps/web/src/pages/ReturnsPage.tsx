import { formatKes } from "@kpos/shared";
import { useState } from "react";
import { api } from "../api";
import { Card, Note, useLoad } from "./ui";

type Doc = {
  id: string;
  type: string;
  number: number;
  issue_date: string;
  customer_name: string | null;
  status: string;
  total_cents: string;
  paid_cents: string;
};

type CreditNote = {
  id: string;
  number: number;
  issue_date: string;
  customer_name: string | null;
  total_cents: string;
  note?: string;
};

export function ReturnsPage() {
  const docs = useLoad<Doc[]>("/documents", []);
  const [selectedDocId, setSelectedDocId] = useState("");
  const [reason, setReason] = useState("");
  const [restock, setRestock] = useState(true);
  const [msg, setMsg] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Eligible documents: Paid Sales or Invoices
  const eligibleSales = docs.data.filter(
    (d) => (d.type === "SALE" || d.type === "INVOICE") && d.status === "PAID"
  );

  // Existing Credit Notes
  const creditNotes = docs.data.filter((d) => d.type === "CREDIT_NOTE");

  async function handleCreateReturn(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedDocId) {
      setMsg("Please select a sale or invoice to refund.");
      return;
    }
    if (!reason.trim()) {
      setMsg("Please state a reason for this return.");
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await api<{ id: string; number: number; total_cents: string }>(
        `/documents/${selectedDocId}/return`,
        {
          method: "POST",
          body: JSON.stringify({
            reason: `${reason}${restock ? " (Restocked to inventory)" : " (Scrapped/No restock)"}`,
          }),
        }
      );
      setMsg(`Credit note CN-${String(res.number).padStart(4, "0")} issued for ${formatKes(Number(res.total_cents))}`);
      setSelectedDocId("");
      setReason("");
      docs.reload();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold">Returns & Credit Notes</h1>
        <p className="text-sm text-muted">Process sales returns, restock inventory, and issue eTIMS-compliant credit notes</p>
      </div>

      <Note msg={msg || docs.msg} />

      <div className="grid gap-6 xl:grid-cols-3">
        {/* Return Form */}
        <Card title="Issue Sales Return" className="xl:col-span-1">
          <form onSubmit={handleCreateReturn} className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase text-muted">
                Select Original Sale / Invoice
              </label>
              <select
                required
                value={selectedDocId}
                onChange={(e) => setSelectedDocId(e.target.value)}
                className="input"
              >
                <option value="">Choose original receipt…</option>
                {eligibleSales.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.type === "SALE" ? "RCT" : "INV"}-{String(s.number).padStart(4, "0")} · {s.customer_name ?? "Walk-in"} · {formatKes(Number(s.total_cents))}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase text-muted">
                Return Reason
              </label>
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
                className="input"
              >
                <option value="">Select reason…</option>
                <option value="Customer return - Defective/Damaged item">Defective / Damaged item</option>
                <option value="Customer return - Wrong variant / size">Wrong variant / size</option>
                <option value="Customer cancellation / return">Customer changed mind</option>
                <option value="Pricing / billing error correction">Billing error correction</option>
              </select>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                id="restock"
                checked={restock}
                onChange={(e) => setRestock(e.target.checked)}
                className="h-4 w-4 rounded border-line text-primary focus:ring-primary"
              />
              <label htmlFor="restock" className="text-sm font-medium">
                Return items to sellable inventory (Restock)
              </label>
            </div>

            <p className="text-xs text-muted">
              Issuing a return deducts the revenue, records a refund against the till shift, and generates a fiscal credit note.
            </p>

            <button
              type="submit"
              disabled={isSubmitting || !selectedDocId}
              className="btn-primary w-full"
            >
              {isSubmitting ? "Processing…" : "Issue Credit Note & Refund"}
            </button>
          </form>
        </Card>

        {/* Credit Notes Ledger */}
        <Card title="Credit Notes Issued" className="xl:col-span-2">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-muted">
                <tr>
                  <th className="py-2.5">Credit Note #</th>
                  <th>Date</th>
                  <th>Customer</th>
                  <th className="text-right">Credit Amount</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {creditNotes.map((cn) => (
                  <tr key={cn.id} className="hover:bg-surface/50">
                    <td className="py-3 font-semibold text-critical">
                      CN-{String(cn.number).padStart(4, "0")}
                    </td>
                    <td>{cn.issue_date.slice(0, 10)}</td>
                    <td>{cn.customer_name ?? "Walk-in Customer"}</td>
                    <td className="num text-right font-bold text-critical">
                      -{formatKes(Number(cn.total_cents))}
                    </td>
                    <td className="text-right">
                      <a
                        href={`/receipt/${cn.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline font-medium"
                      >
                        Print Credit Note
                      </a>
                    </td>
                  </tr>
                ))}
                {creditNotes.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-muted">
                      No credit notes issued yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
