import { formatKes, toCents } from "@kpos/shared";
import { useEffect, useState } from "react";
import { api } from "../api";
import { Card, Note } from "./ui";

type Customer = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  kra_pin: string | null;
  price_tier: string;
  credit_limit_cents: string;
  payment_terms_days: number;
};

type CustomerStatement = {
  customer: Customer;
  documents: {
    id: string;
    type: string;
    number: number;
    status: string;
    issue_date: string;
    due_date: string | null;
    total_cents: string;
    paid_cents: string;
  }[];
  payments: {
    id: string;
    method: string;
    amount_cents: string;
    reference: string | null;
    created_at: string;
    doc_number: number;
    doc_type: string;
  }[];
  summary: {
    totalInvoicedCents: number;
    totalPaidCents: number;
    totalCreditNotesCents: number;
    balanceCents: number;
    creditLimitCents: number;
    availableCreditCents: number;
  };
};

export function CustomersPage() {
  const [items, setItems] = useState<Customer[]>([]);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const [selectedStatement, setSelectedStatement] = useState<CustomerStatement | null>(null);
  const [loadingStatement, setLoadingStatement] = useState(false);

  const load = (query = q) =>
    api<Customer[]>(`/customers${query ? `?q=${encodeURIComponent(query)}` : ""}`)
      .then(setItems)
      .catch((e: Error) => setMsg(e.message));

  useEffect(() => {
    load("");
  }, []);

  async function openStatement(customerId: string) {
    setLoadingStatement(true);
    setMsg("");
    try {
      const res = await api<CustomerStatement>(`/customers/${customerId}/statement`);
      setSelectedStatement(res);
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setLoadingStatement(false);
    }
  }

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    try {
      await api("/customers", {
        method: "POST",
        body: JSON.stringify({
          name: f.name,
          phone: f.phone || undefined,
          email: f.email || undefined,
          kraPin: f.kraPin ? f.kraPin.toUpperCase() : undefined,
          priceTier: f.priceTier,
          creditLimitCents: f.credit ? toCents(f.credit) : 0,
          paymentTermsDays: Number(f.terms || 0),
        }),
      });
      form.reset();
      setMsg("Customer added successfully.");
      load();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold">Customers & Debtors Ledger</h1>
          <p className="text-sm text-muted">Customer account profiles, credit limits, KRA PINs, and debtor statements</p>
        </div>
      </div>

      <Note msg={msg} />

      <div className="grid gap-6 xl:grid-cols-3">
        {/* Customer Directory Table (2 Cols) */}
        <Card title="Customer Accounts" className="xl:col-span-2">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && load()}
              placeholder="Search name, phone or KRA PIN..."
              className="input max-w-sm"
            />
            <button onClick={() => load()} className="btn-primary px-4 text-xs h-10">
              Search
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-muted">
                <tr>
                  <th className="py-2.5">Name</th>
                  <th>Phone</th>
                  <th>KRA PIN</th>
                  <th>Price Tier</th>
                  <th className="text-right">Credit Limit</th>
                  <th className="text-right">Terms</th>
                  <th className="text-right">Statement</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((c) => (
                  <tr key={c.id} className="hover:bg-surface/50">
                    <td className="py-3 font-semibold text-ink">{c.name}</td>
                    <td>{c.phone ?? "—"}</td>
                    <td className="font-mono text-xs">{c.kra_pin ?? "—"}</td>
                    <td>
                      <span className="rounded bg-surface px-2 py-0.5 text-xs font-semibold text-muted">
                        {c.price_tier}
                      </span>
                    </td>
                    <td className="num text-right font-medium">{formatKes(Number(c.credit_limit_cents))}</td>
                    <td className="text-right text-xs text-muted">{c.payment_terms_days} days</td>
                    <td className="text-right">
                      <button
                        onClick={() => openStatement(c.id)}
                        className="rounded bg-primary/10 px-2.5 py-1 text-xs font-bold text-primary hover:bg-primary/20"
                      >
                        View Statement
                      </button>
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-muted">
                      No customers found. Add your first customer profile below.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Add Customer Form */}
        <Card title="Add New Customer">
          <form onSubmit={add} className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase text-muted">Business / Individual Name</label>
              <input name="name" placeholder="e.g. Mega Agro Supplies Ltd" required className="input" />
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase text-muted">Phone Number</label>
              <input name="phone" placeholder="0712345678" inputMode="tel" className="input" />
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase text-muted">Email Address (Optional)</label>
              <input name="email" type="email" placeholder="accounts@business.co.ke" className="input" />
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase text-muted">KRA PIN (for eTIMS Invoicing)</label>
              <input name="kraPin" placeholder="P051234567Z" className="input uppercase font-mono" />
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase text-muted">Price Tier</label>
              <select name="priceTier" className="input">
                <option value="RETAIL">Standard Retail Tier</option>
                <option value="WHOLESALE">Wholesale Volume Tier</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase text-muted">Credit Limit (KES)</label>
                <input name="credit" placeholder="0.00" inputMode="decimal" className="input" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase text-muted">Terms (Days)</label>
                <input name="terms" placeholder="30" defaultValue="30" inputMode="numeric" className="input" />
              </div>
            </div>

            <button className="btn-primary w-full mt-2">Save Customer Profile</button>
          </form>
        </Card>
      </div>

      {/* Statement Modal / Drawer */}
      {selectedStatement && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/50 p-4 backdrop-blur-xs">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-line bg-card p-6 shadow-2xl space-y-6">
            <div className="flex items-start justify-between border-b border-line pb-4">
              <div>
                <h2 className="font-display text-xl font-bold">{selectedStatement.customer.name}</h2>
                <p className="text-xs text-muted">
                  KRA PIN: {selectedStatement.customer.kra_pin ?? "N/A"} · Phone: {selectedStatement.customer.phone ?? "N/A"}
                </p>
              </div>
              <button
                onClick={() => setSelectedStatement(null)}
                className="rounded-lg p-2 text-muted hover:bg-surface hover:text-ink"
              >
                ✕
              </button>
            </div>

            {/* Financial Status Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-xl border border-line bg-surface p-3">
                <span className="text-xs uppercase text-muted font-medium">Outstanding Debt</span>
                <p className="num mt-1 font-display text-lg font-bold text-critical">
                  {formatKes(selectedStatement.summary.balanceCents)}
                </p>
              </div>
              <div className="rounded-xl border border-line bg-surface p-3">
                <span className="text-xs uppercase text-muted font-medium">Credit Limit</span>
                <p className="num mt-1 font-display text-lg font-bold">
                  {formatKes(selectedStatement.summary.creditLimitCents)}
                </p>
              </div>
              <div className="rounded-xl border border-line bg-surface p-3">
                <span className="text-xs uppercase text-muted font-medium">Available Credit</span>
                <p className="num mt-1 font-display text-lg font-bold text-primary">
                  {formatKes(selectedStatement.summary.availableCreditCents)}
                </p>
              </div>
              <div className="rounded-xl border border-line bg-surface p-3">
                <span className="text-xs uppercase text-muted font-medium">Total Invoiced</span>
                <p className="num mt-1 font-display text-lg font-bold">
                  {formatKes(selectedStatement.summary.totalInvoicedCents)}
                </p>
              </div>
            </div>

            {/* Invoices List */}
            <div>
              <h3 className="mb-2 text-sm font-bold uppercase tracking-wider text-muted">Invoices & Charges</h3>
              <div className="overflow-x-auto border border-line rounded-xl">
                <table className="w-full text-left text-xs">
                  <thead className="bg-surface text-muted border-b border-line">
                    <tr>
                      <th className="py-2 px-3">Invoice #</th>
                      <th>Date</th>
                      <th>Due Date</th>
                      <th>Status</th>
                      <th className="text-right">Total</th>
                      <th className="text-right px-3">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {selectedStatement.documents.map((d) => (
                      <tr key={d.id}>
                        <td className="py-2 px-3 font-semibold">
                          {d.type === "CREDIT_NOTE" ? "CN" : d.type === "SALE" ? "RCT" : "INV"}-
                          {String(d.number).padStart(4, "0")}
                        </td>
                        <td>{d.issue_date.slice(0, 10)}</td>
                        <td>{d.due_date?.slice(0, 10) ?? "—"}</td>
                        <td>{d.status}</td>
                        <td className="num text-right">{formatKes(Number(d.total_cents))}</td>
                        <td className="num text-right px-3 font-bold">
                          {d.type === "CREDIT_NOTE" ? "—" : formatKes(Number(d.total_cents) - Number(d.paid_cents))}
                        </td>
                      </tr>
                    ))}
                    {selectedStatement.documents.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-4 text-center text-muted">
                          No transactions found for this customer.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Payments History */}
            <div>
              <h3 className="mb-2 text-sm font-bold uppercase tracking-wider text-muted">Payment History</h3>
              <div className="overflow-x-auto border border-line rounded-xl">
                <table className="w-full text-left text-xs">
                  <thead className="bg-surface text-muted border-b border-line">
                    <tr>
                      <th className="py-2 px-3">Date</th>
                      <th>Method</th>
                      <th>Reference / M-Pesa Code</th>
                      <th>Allocated Doc</th>
                      <th className="text-right px-3">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {selectedStatement.payments.map((p) => (
                      <tr key={p.id}>
                        <td className="py-2 px-3">{new Date(p.created_at).toLocaleDateString()}</td>
                        <td className="font-semibold">{p.method}</td>
                        <td className="font-mono">{p.reference ?? "—"}</td>
                        <td>{p.doc_type}-{String(p.doc_number).padStart(4, "0")}</td>
                        <td className="num text-right px-3 font-bold text-primary">
                          {formatKes(Number(p.amount_cents))}
                        </td>
                      </tr>
                    ))}
                    {selectedStatement.payments.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-4 text-center text-muted">
                          No payments recorded yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2 border-t border-line">
              <button
                onClick={() => window.print()}
                className="btn-primary text-xs px-4"
              >
                Print Customer Statement
              </button>
              <button
                onClick={() => setSelectedStatement(null)}
                className="rounded-lg border border-line px-4 py-2 text-xs font-semibold hover:bg-surface"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
