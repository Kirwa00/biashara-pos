import { computeLine, formatKes, toCents, unitPrice, type TaxCode } from "@kpos/shared";
import { useState } from "react";
import { api } from "../api";
import { Card, Note, useLoad, type Customer, type Product } from "./ui";

type Doc = {
  id: string;
  type: string;
  number: number;
  customer_name: string | null;
  status: string;
  issue_date: string;
  due_date: string | null;
  net_cents: string;
  tax_cents: string;
  total_cents: string;
  paid_cents: string;
};

type DraftLine = {
  product: Product;
  quantity: number;
};

const PREFIX: Record<string, string> = {
  QUOTE: "QT",
  INVOICE: "INV",
  SALE: "RCT",
  CREDIT_NOTE: "CN",
};

export function InvoicesPage() {
  const docs = useLoad<Doc[]>("/documents", []);
  const products = useLoad<Product[]>("/products?limit=500", []);
  const customers = useLoad<Customer[]>("/customers", []);

  // Creation State
  const [docType, setDocType] = useState<"QUOTE" | "INVOICE">("INVOICE");
  const [customerId, setCustomerId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [lineQty, setLineQty] = useState("1");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Filter State
  const [filterType, setFilterType] = useState("ALL");

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      docs.setMsg(ok);
      docs.reload();
    } catch (e) {
      docs.setMsg((e as Error).message);
    }
  };

  const addLine = () => {
    if (!selectedProductId) return;
    const prod = products.data.find((p) => p.id === selectedProductId);
    if (!prod) return;
    const qty = Math.max(1, Number(lineQty) || 1);

    setLines((curr) => {
      const idx = curr.findIndex((l) => l.product.id === prod.id);
      if (idx >= 0) {
        return curr.map((l, i) => (i === idx ? { ...l, quantity: l.quantity + qty } : l));
      }
      return [...curr, { product: prod, quantity: qty }];
    });

    setSelectedProductId("");
    setLineQty("1");
  };

  const removeLine = (productId: string) => {
    setLines((curr) => curr.filter((l) => l.product.id !== productId));
  };

  const draftTotals = lines.reduce(
    (acc, l) => {
      const price = unitPrice(
        {
          retailPriceCents: Number(l.product.retail_price_cents),
          wholesalePriceCents: l.product.wholesale_price_cents == null ? null : Number(l.product.wholesale_price_cents),
          wholesaleMinQty: l.product.wholesale_min_qty == null ? null : Number(l.product.wholesale_min_qty),
        },
        l.quantity
      );
      const computed = computeLine({
        quantity: l.quantity,
        taxCode: l.product.tax_code as TaxCode,
        priceIncludesTax: l.product.price_includes_tax,
        unitPriceCents: price,
      });
      return {
        net: acc.net + computed.netCents,
        tax: acc.tax + computed.taxCents,
        total: acc.total + computed.totalCents,
      };
    },
    { net: 0, tax: 0, total: 0 }
  );

  async function handleCreateDoc(e: React.FormEvent) {
    e.preventDefault();
    if (!lines.length) {
      docs.setMsg("Please add at least one product line.");
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await api<{ id: string; number: number; total_cents: string }>("/documents", {
        method: "POST",
        body: JSON.stringify({
          type: docType,
          customerId: customerId || undefined,
          dueDate: dueDate || undefined,
          lines: lines.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
        }),
      });
      docs.setMsg(`${docType === "QUOTE" ? "Quotation" : "Invoice"} #${res.number} created successfully.`);
      setLines([]);
      setCustomerId("");
      setDueDate("");
      docs.reload();
    } catch (err) {
      docs.setMsg((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }

  const filteredDocs = docs.data.filter((d) => {
    if (filterType === "ALL") return true;
    return d.type === filterType;
  });

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      {/* Document Ledger (2 Cols) */}
      <Card title="Sales, Quotations & Invoices Ledger" className="xl:col-span-2">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-1.5 rounded-lg border border-line bg-surface p-1 text-xs font-semibold">
            {["ALL", "INVOICE", "QUOTE", "SALE", "CREDIT_NOTE"].map((t) => (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                className={`rounded px-2.5 py-1 transition ${
                  filterType === t ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink"
                }`}
              >
                {t === "ALL" ? "All" : t === "CREDIT_NOTE" ? "Credit Notes" : t.charAt(0) + t.slice(1).toLowerCase() + "s"}
              </button>
            ))}
          </div>
          <span className="text-xs text-muted font-medium">{filteredDocs.length} documents found</span>
        </div>

        <Note msg={docs.msg} />

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="py-2.5">Doc #</th>
                <th>Customer</th>
                <th>Issue Date</th>
                <th>Status</th>
                <th>Due</th>
                <th className="text-right">Total</th>
                <th className="text-right">Balance</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filteredDocs.map((d) => {
                const bal = Number(d.total_cents) - Number(d.paid_cents);
                const isOverdue = d.due_date && new Date(d.due_date) < new Date() && bal > 0;
                return (
                  <tr key={d.id} className="hover:bg-surface/50">
                    <td className="py-3 font-semibold">
                      {PREFIX[d.type] || "DOC"}-{String(d.number).padStart(4, "0")}
                    </td>
                    <td>{d.customer_name ?? "Walk-in"}</td>
                    <td className="text-xs text-muted">{d.issue_date.slice(0, 10)}</td>
                    <td>
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
                          d.status === "PAID"
                            ? "bg-emerald-50 text-emerald-700"
                            : d.status === "OPEN"
                            ? "bg-blue-50 text-blue-700"
                            : isOverdue
                            ? "bg-red-50 text-critical"
                            : "bg-amber-50 text-warning"
                        }`}
                      >
                        {d.status}
                      </span>
                    </td>
                    <td className={`text-xs ${isOverdue ? "font-bold text-critical" : "text-muted"}`}>
                      {d.due_date?.slice(0, 10) ?? "—"}
                    </td>
                    <td className="num text-right font-medium">{formatKes(Number(d.total_cents))}</td>
                    <td className={`num text-right font-semibold ${bal > 0 ? "text-critical" : "text-muted"}`}>
                      {d.type === "QUOTE" || d.type === "CREDIT_NOTE" ? "—" : formatKes(bal)}
                    </td>
                    <td className="space-x-2 text-right">
                      <a
                        className="text-primary hover:underline font-medium text-xs"
                        href={`/receipt/${d.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Print
                      </a>
                      {d.type === "QUOTE" && d.status === "OPEN" && (
                        <button
                          className="rounded bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary hover:bg-primary/20"
                          onClick={() => act(() => api(`/documents/${d.id}/convert`, { method: "POST" }), "Quotation converted to official Invoice")}
                        >
                          Convert to Invoice
                        </button>
                      )}
                      {d.type !== "QUOTE" && d.type !== "CREDIT_NOTE" && bal > 0 && (
                        <>
                          <button
                            className="rounded bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-700 hover:bg-slate-200"
                            onClick={() => {
                              const amt = prompt(`Enter cash amount received (Max ${formatKes(bal)}):`, String(bal / 100));
                              if (amt)
                                act(
                                  () =>
                                    api(`/documents/${d.id}/payments`, {
                                      method: "POST",
                                      body: JSON.stringify({ method: "CASH", amountCents: toCents(amt) }),
                                    }),
                                  "Payment recorded"
                                );
                            }}
                          >
                            Pay Cash
                          </button>
                          <button
                            className="rounded bg-emerald-50 px-2 py-0.5 text-xs font-bold text-primary hover:bg-emerald-100"
                            onClick={() => {
                              const phone = prompt("Customer M-Pesa phone (07…):");
                              if (!phone) return;
                              const amt = prompt(`M-Pesa amount in whole KES (Max ${Math.floor(bal / 100)}):`, String(Math.floor(bal / 100)));
                              if (!amt) return;
                              const kes = Number(amt.trim());
                              if (!/^\d+$/.test(amt.trim()) || kes < 1 || kes * 100 > bal) {
                                docs.setMsg(`Enter whole shillings from 1 to ${Math.floor(bal / 100)}`);
                                return;
                              }
                              act(
                                () =>
                                  api("/payments/stk", {
                                    method: "POST",
                                    body: JSON.stringify({ documentId: d.id, phone: phone.trim(), amountCents: kes * 100 }),
                                  }),
                                `STK Push sent to ${phone}. Invoice will auto-update on callback.`
                              );
                            }}
                          >
                            STK
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {filteredDocs.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-muted">
                    No matching documents found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Create Quotation / Invoice Slip Builder */}
      <Card title={`New ${docType === "QUOTE" ? "Quotation" : "Tax Invoice"}`}>
        <form onSubmit={handleCreateDoc} className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setDocType("INVOICE")}
              className={`rounded-lg py-2 text-xs font-bold transition ${
                docType === "INVOICE" ? "bg-navy text-white shadow-xs" : "border border-line bg-surface text-muted"
              }`}
            >
              Tax Invoice
            </button>
            <button
              type="button"
              onClick={() => setDocType("QUOTE")}
              className={`rounded-lg py-2 text-xs font-bold transition ${
                docType === "QUOTE" ? "bg-navy text-white shadow-xs" : "border border-line bg-surface text-muted"
              }`}
            >
              Quotation
            </button>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase text-muted">Customer</label>
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              required={docType === "INVOICE"}
              className="input"
            >
              <option value="">Choose Customer…</option>
              {customers.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {docType === "INVOICE" && (
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase text-muted">Payment Due Date</label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="input"
              />
            </div>
          )}

          {/* Add Line Section */}
          <div className="rounded-xl border border-line bg-surface/50 p-3 space-y-2">
            <span className="text-xs font-bold uppercase text-muted">Add Items</span>
            <select
              value={selectedProductId}
              onChange={(e) => setSelectedProductId(e.target.value)}
              className="input text-sm"
            >
              <option value="">Select product to add…</option>
              {products.data.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} — {p.name} ({formatKes(Number(p.retail_price_cents))})
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <input
                type="number"
                min="1"
                placeholder="Qty"
                value={lineQty}
                onChange={(e) => setLineQty(e.target.value)}
                className="input w-24 text-center font-bold"
              />
              <button
                type="button"
                onClick={addLine}
                disabled={!selectedProductId}
                className="btn-primary flex-1 text-xs"
              >
                + Add Line
              </button>
            </div>
          </div>

          {/* Line Items List */}
          <div className="divide-y divide-line border-y border-line max-h-48 overflow-y-auto">
            {lines.map((l) => (
              <div key={l.product.id} className="py-2 flex items-center justify-between text-xs">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold truncate">{l.product.name}</p>
                  <p className="text-muted">
                    {l.quantity} × {formatKes(Number(l.product.retail_price_cents))}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="num font-bold">
                    {formatKes(Number(l.product.retail_price_cents) * l.quantity)}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeLine(l.product.id)}
                    className="text-critical font-bold px-1"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
            {lines.length === 0 && (
              <p className="py-4 text-center text-xs text-muted">No line items added yet.</p>
            )}
          </div>

          {/* Totals Summary */}
          <div className="space-y-1 text-xs">
            <div className="flex justify-between text-muted">
              <span>Subtotal (Net):</span>
              <span className="num">{formatKes(draftTotals.net)}</span>
            </div>
            <div className="flex justify-between text-muted">
              <span>16% VAT:</span>
              <span className="num">{formatKes(draftTotals.tax)}</span>
            </div>
            <div className="flex justify-between font-bold text-sm text-ink pt-1 border-t border-line">
              <span>Total:</span>
              <span className="num font-display text-primary">{formatKes(draftTotals.total)}</span>
            </div>
          </div>

          <button
            type="submit"
            disabled={isSubmitting || !lines.length}
            className="btn-primary w-full py-3 text-sm font-bold shadow-sm"
          >
            {isSubmitting ? "Saving…" : `Generate ${docType === "QUOTE" ? "Quotation" : "Invoice"}`}
          </button>
        </form>
      </Card>
    </div>
  );
}
