import { formatKes, toCents } from "@kpos/shared";
import { api } from "../api";
import { Card, formData, Note, ProductSelect, useLoad, type Customer, type Product } from "./ui";

type Doc = { id: string; type: string; number: number; customer_name: string | null; status: string; total_cents: string; paid_cents: string; due_date: string | null };
const PREFIX: Record<string, string> = { QUOTE: "QT", INVOICE: "INV", SALE: "RCT" };

export function InvoicesPage() {
  const docs = useLoad<Doc[]>("/documents", []);
  const products = useLoad<Product[]>("/products?limit=500", []);
  const customers = useLoad<Customer[]>("/customers", []);
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); docs.setMsg(ok); docs.reload(); } catch (e) { docs.setMsg((e as Error).message); } };
  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card title="Sales, quotations & invoices" className="xl:col-span-2">
        <Note msg={docs.msg} />
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">No.</th><th>Customer</th><th>Status</th><th>Due</th><th className="text-right">Total</th><th className="text-right">Balance</th><th /></tr></thead>
          <tbody>{docs.data.map((d) => { const bal = Number(d.total_cents) - Number(d.paid_cents); return (
            <tr key={d.id} className="border-t border-line">
              <td className="py-3">{PREFIX[d.type]}-{String(d.number).padStart(4, "0")}</td><td>{d.customer_name ?? "Walk-in"}</td><td>{d.status}</td><td>{d.due_date?.slice(0, 10) ?? "—"}</td>
              <td className="num text-right">{formatKes(Number(d.total_cents))}</td><td className="num text-right">{d.type === "QUOTE" ? "—" : formatKes(bal)}</td>
              <td className="space-x-2 text-right">
                {d.type === "QUOTE" && d.status === "OPEN" && <button className="text-primary" onClick={() => act(() => api(`/documents/${d.id}/convert`, { method: "POST" }), "Converted to invoice")}>Invoice</button>}
                {d.type !== "QUOTE" && bal > 0 && <button className="text-primary" onClick={() => { const amt = prompt("Amount received (KES)"); if (amt) act(() => api(`/documents/${d.id}/payments`, { method: "POST", body: JSON.stringify({ method: "CASH", amountCents: toCents(amt) }) }), "Payment recorded"); }}>Pay</button>}
                {d.type !== "QUOTE" && bal > 0 && <button className="text-primary" onClick={() => { const phone = prompt("M-Pesa phone 07…"); if (phone) act(() => api("/payments/stk", { method: "POST", body: JSON.stringify({ documentId: d.id, phone, amountCents: bal }) }), "STK push sent — waiting for customer"); }}>STK</button>}
              </td>
            </tr>); })}</tbody>
        </table>
      </Card>
      <Card title="New quotation / invoice">
        <form className="space-y-3" onSubmit={(e) => { const f = formData(e); act(() => api("/documents", { method: "POST", body: JSON.stringify({ type: f.type, customerId: f.customerId || undefined, lines: [{ productId: f.productId, quantity: Number(f.qty) }] }) }), "Saved"); }}>
          <select name="type" className="input"><option value="QUOTE">Quotation</option><option value="INVOICE">Invoice</option></select>
          <select name="customerId" required className="input"><option value="">Customer…</option>{customers.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <ProductSelect products={products.data} /><input name="qty" placeholder="Qty" required className="input" />
          <button className="btn-primary w-full">Save</button>
        </form>
      </Card>
    </div>
  );
}
