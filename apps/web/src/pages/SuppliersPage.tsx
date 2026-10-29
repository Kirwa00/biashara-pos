import { formatKes, toCents } from "@kpos/shared";
import { api } from "../api";
import { Card, formData, Note, ProductSelect, useLoad, type Product } from "./ui";

type Supplier = { id: string; name: string; phone: string | null };
type Purchase = { id: string; number: number; supplier_name: string; total_cents: string; created_at: string };

export function SuppliersPage() {
  const suppliers = useLoad<Supplier[]>("/suppliers", []);
  const purchases = useLoad<Purchase[]>("/purchases", []);
  const products = useLoad<Product[]>("/products?limit=500", []);
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); purchases.setMsg(ok); suppliers.reload(); purchases.reload(); } catch (e) { purchases.setMsg((e as Error).message); } };
  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card title="Goods received" className="xl:col-span-2">
        <Note msg={purchases.msg} />
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">GRN</th><th>Supplier</th><th>Date</th><th className="text-right">Total</th></tr></thead>
          <tbody>{purchases.data.map((p) => (
            <tr key={p.id} className="border-t border-line"><td className="py-3">GRN-{String(p.number).padStart(4, "0")}</td><td>{p.supplier_name}</td><td>{p.created_at.slice(0, 10)}</td><td className="num text-right">{formatKes(Number(p.total_cents))}</td></tr>))}</tbody>
        </table>
      </Card>
      <div className="space-y-6">
        <Card title="Receive stock">
          <form className="space-y-3" onSubmit={(e) => { const f = formData(e); act(() => api("/purchases", { method: "POST", body: JSON.stringify({ supplierId: f.supplierId, supplierRef: f.ref || undefined, lines: [{ productId: f.productId, quantity: Number(f.qty), unitCostCents: toCents(f.cost ?? "0") }] }) }), "Stock received"); }}>
            <select name="supplierId" required className="input"><option value="">Supplier…</option>{suppliers.data.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            <ProductSelect products={products.data} />
            <div className="grid grid-cols-2 gap-3"><input name="qty" placeholder="Qty" required className="input" /><input name="cost" placeholder="Unit cost KES" required className="input" /></div>
            <input name="ref" placeholder="Supplier invoice no." className="input" />
            <button className="btn-primary w-full">Receive</button>
          </form>
        </Card>
        <Card title="Add supplier">
          <form className="space-y-3" onSubmit={(e) => { const f = formData(e); act(() => api("/suppliers", { method: "POST", body: JSON.stringify({ name: f.name, phone: f.phone || undefined }) }), "Supplier added"); }}>
            <input name="name" placeholder="Name" required className="input" /><input name="phone" placeholder="Phone" className="input" />
            <button className="btn-primary w-full">Save</button>
          </form>
        </Card>
      </div>
    </div>
  );
}
