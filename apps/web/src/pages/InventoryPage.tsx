import { toCents } from "@kpos/shared";
import { api } from "../api";
import { Card, formData, Note, ProductSelect, useLoad, type Product } from "./ui";

type Row = { product_id: string; sku: string; name: string; on_hand: string; reorder_level: string; avg_cost_cents: string; low_stock: boolean };
type Adj = { id: string; product_name: string; quantity: string; reason: string; status: string; requested_by_name: string };

export function InventoryPage() {
  const stock = useLoad<Row[]>("/stock", []);
  const adjs = useLoad<Adj[]>("/stock/adjustments?status=PENDING", []);
  const products = useLoad<Product[]>("/products?limit=500", []);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); stock.setMsg(ok); stock.reload(); adjs.reload(); } catch (e) { stock.setMsg((e as Error).message); }
  };
  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card title="Stock on hand" className="xl:col-span-2">
        <Note msg={stock.msg} />
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">SKU</th><th>Product</th><th className="text-right">On hand</th><th className="text-right">Reorder at</th><th /></tr></thead>
          <tbody>{stock.data.map((r) => (
            <tr key={r.product_id} className="border-t border-line">
              <td className="py-3">{r.sku}</td><td>{r.name}</td><td className="num text-right">{Number(r.on_hand)}</td><td className="text-right">{Number(r.reorder_level)}</td>
              <td className="text-right">{r.low_stock && <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-700">Low</span>}</td>
            </tr>))}</tbody>
        </table>
        {adjs.data.length > 0 && <h3 className="mt-6 mb-2 font-bold">Pending adjustments</h3>}
        {adjs.data.map((a) => (
          <div key={a.id} className="flex items-center gap-3 border-t border-line py-2 text-sm">
            <span className="flex-1">{a.product_name}: {Number(a.quantity)} — {a.reason} ({a.requested_by_name})</span>
            <button className="btn-primary" onClick={() => act(() => api(`/stock/adjustments/${a.id}/approve`, { method: "POST" }), "Approved")}>Approve</button>
            <button className="rounded-lg border border-line px-3 py-2" onClick={() => act(() => api(`/stock/adjustments/${a.id}/reject`, { method: "POST" }), "Rejected")}>Reject</button>
          </div>))}
      </Card>
      <div className="space-y-6">
        <Card title="Opening stock">
          <form className="space-y-3" onSubmit={(e) => { const f = formData(e); act(() => api("/stock/opening", { method: "POST", body: JSON.stringify({ lines: [{ productId: f.productId, quantity: Number(f.qty), unitCostCents: toCents(f.cost || "0") }] }) }), "Opening stock saved"); }}>
            <ProductSelect products={products.data} /><div className="grid grid-cols-2 gap-3"><input name="qty" placeholder="Qty" inputMode="decimal" required className="input" /><input name="cost" placeholder="Unit cost KES" inputMode="decimal" className="input" /></div>
            <button className="btn-primary w-full">Save</button>
          </form>
        </Card>
        <Card title="Adjust stock">
          <form className="space-y-3" onSubmit={(e) => { const f = formData(e); act(() => api("/stock/adjustments", { method: "POST", body: JSON.stringify({ productId: f.productId, quantity: Number(f.qty), reason: f.reason }) }), "Adjustment submitted"); }}>
            <ProductSelect products={products.data} /><input name="qty" placeholder="+/- qty" required className="input" /><input name="reason" placeholder="Reason (damaged, expired…)" required className="input" />
            <button className="btn-primary w-full">Submit</button>
          </form>
        </Card>
        <Card title="Stock count">
          <form className="space-y-3" onSubmit={(e) => { const f = formData(e); act(() => api("/stock/counts", { method: "POST", body: JSON.stringify({ lines: [{ productId: f.productId, counted: Number(f.counted) }] }) }), "Count posted"); }}>
            <ProductSelect products={products.data} /><input name="counted" placeholder="Counted qty" required className="input" />
            <button className="btn-primary w-full">Post count</button>
          </form>
        </Card>
      </div>
    </div>
  );
}
