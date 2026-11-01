import { formatKes, toCents } from "@kpos/shared";
import { useState } from "react";
import { api } from "../api";
import { Card, Note, useLoad, type Product } from "./ui";

type Order = {
  id: string;
  number: number;
  supplier_name: string;
  status: "PENDING" | "APPROVED" | "PARTIAL" | "RECEIVED" | "CANCELLED";
  total_cents: string;
  outstanding_cents: string;
  created_at: string;
};
type OrderLine = { product_id: string; product_name: string; quantity_ordered: string; quantity_received: string; unit_cost_cents: string };
type Draft = { productId: string; name: string; quantity: number; unitCostCents: number };

const badge: Record<Order["status"], string> = {
  PENDING: "bg-amber-50 text-amber-700",
  APPROVED: "bg-sky-50 text-sky-700",
  PARTIAL: "bg-indigo-50 text-indigo-700",
  RECEIVED: "bg-emerald-50 text-emerald-700",
  CANCELLED: "bg-surface text-muted",
};

export function PurchaseOrdersPage() {
  const orders = useLoad<Order[]>("/purchase-orders", []);
  const suppliers = useLoad<{ id: string; name: string }[]>("/suppliers", []);
  const products = useLoad<Product[]>("/products?limit=500", []);
  const [supplierId, setSupplierId] = useState("");
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [draft, setDraft] = useState<Draft[]>([]);
  const [receiving, setReceiving] = useState<{ order: Order; lines: OrderLine[]; qty: Record<string, string>; ref: string } | null>(null);
  const [msg, setMsg] = useState("");

  const run = async (fn: () => Promise<string>) => {
    setMsg("");
    try {
      setMsg(await fn());
      orders.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  function addLine() {
    const p = products.data.find((x) => x.id === productId);
    if (!p || !(Number(quantity) > 0) || unitCost === "") return setMsg("Pick a product, quantity and unit cost.");
    if (draft.some((d) => d.productId === p.id)) return setMsg("That product is already on the order.");
    setDraft([...draft, { productId: p.id, name: p.name, quantity: Number(quantity), unitCostCents: toCents(unitCost) }]);
    setProductId("");
    setQuantity("");
    setUnitCost("");
  }

  const createOrder = () =>
    run(async () => {
      const po = await api<{ number: number }>("/purchase-orders", {
        method: "POST",
        body: JSON.stringify({ supplierId, lines: draft.map(({ productId, quantity, unitCostCents }) => ({ productId, quantity, unitCostCents })) }),
      });
      setDraft([]);
      return `PO-${String(po.number).padStart(4, "0")} raised and waiting for approval.`;
    });

  const act = (o: Order, action: "approve" | "cancel") =>
    run(async () => {
      await api(`/purchase-orders/${o.id}/${action}`, { method: "POST" });
      return `PO-${String(o.number).padStart(4, "0")} ${action === "approve" ? "approved" : "cancelled"}.`;
    });

  async function openReceive(o: Order) {
    setMsg("");
    try {
      const d = await api<{ lines: OrderLine[] }>(`/purchase-orders/${o.id}`);
      const qty = Object.fromEntries(d.lines.map((l) => [l.product_id, String(Number(l.quantity_ordered) - Number(l.quantity_received))]));
      setReceiving({ order: o, lines: d.lines, qty, ref: "" });
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  const receive = () =>
    run(async () => {
      if (!receiving) return "";
      const lines = Object.entries(receiving.qty).map(([productId, q]) => ({ productId, quantity: Number(q) })).filter((l) => l.quantity > 0);
      const r = await api<{ purchase: { number: number }; status: string }>(`/purchase-orders/${receiving.order.id}/receive`, {
        method: "POST",
        body: JSON.stringify({ lines, supplierRef: receiving.ref || undefined }),
      });
      setReceiving(null);
      return `GRN-${String(r.purchase.number).padStart(4, "0")} posted; order is now ${r.status.toLowerCase()}.`;
    });

  const draftTotal = draft.reduce((s, d) => s + Math.round(d.quantity * d.unitCostCents), 0);
  const outstanding = orders.data.reduce((s, o) => s + Number(o.outstanding_cents), 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold">Purchase Orders</h1>
          <p className="text-sm text-muted">Raise, approve and receive supplier orders. Stock only moves when goods are received.</p>
        </div>
        <div className="rounded-xl border border-line bg-card px-4 py-2 text-right">
          <span className="text-xs font-medium uppercase text-muted">Still to be delivered</span>
          <p className="num font-display text-xl font-bold text-primary">{formatKes(outstanding)}</p>
        </div>
      </div>

      <Note msg={msg || orders.msg} />

      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Orders" className="xl:col-span-2">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-muted">
                <tr>
                  <th className="py-2.5">PO #</th>
                  <th>Supplier</th>
                  <th>Status</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Outstanding</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {orders.data.map((o) => (
                  <tr key={o.id}>
                    <td className="py-3 font-semibold">PO-{String(o.number).padStart(4, "0")}</td>
                    <td>{o.supplier_name}</td>
                    <td>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${badge[o.status]}`}>{o.status}</span>
                    </td>
                    <td className="num text-right">{formatKes(Number(o.total_cents))}</td>
                    <td className="num text-right">{formatKes(Number(o.outstanding_cents))}</td>
                    <td className="space-x-2 text-right text-xs font-semibold">
                      {o.status === "PENDING" && <button className="text-primary" onClick={() => act(o, "approve")}>Approve</button>}
                      {(o.status === "APPROVED" || o.status === "PARTIAL") && <button className="text-primary" onClick={() => openReceive(o)}>Receive</button>}
                      {["PENDING", "APPROVED", "PARTIAL"].includes(o.status) && <button className="text-red-600" onClick={() => act(o, "cancel")}>Cancel</button>}
                    </td>
                  </tr>
                ))}
                {orders.data.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-muted">No purchase orders yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="space-y-6">
          {receiving && (
            <Card title={`Receive PO-${String(receiving.order.number).padStart(4, "0")}`}>
              <div className="space-y-3 text-sm">
                {receiving.lines.map((l) => (
                  <label key={l.product_id} className="block">
                    {l.product_name} <span className="text-muted">({Number(l.quantity_received)} of {Number(l.quantity_ordered)} received)</span>
                    <input className="input mt-1" type="number" min="0" step="any" value={receiving.qty[l.product_id]}
                      onChange={(e) => setReceiving({ ...receiving, qty: { ...receiving.qty, [l.product_id]: e.target.value } })} />
                  </label>
                ))}
                <input className="input" placeholder="Supplier invoice / delivery ref" value={receiving.ref} onChange={(e) => setReceiving({ ...receiving, ref: e.target.value })} />
                <div className="flex gap-2">
                  <button className="btn-primary" onClick={receive}>Post GRN</button>
                  <button className="rounded-lg border border-line px-3 py-2 font-semibold" onClick={() => setReceiving(null)}>Close</button>
                </div>
              </div>
            </Card>
          )}

          <Card title="New purchase order">
            <div className="space-y-3 text-sm">
              <select className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">Select supplier…</option>
                {suppliers.data.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <select className="input" value={productId} onChange={(e) => setProductId(e.target.value)}>
                <option value="">Product…</option>
                {products.data.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}
              </select>
              <div className="grid grid-cols-2 gap-2">
                <input className="input" type="number" min="0" step="any" placeholder="Qty" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
                <input className="input" type="number" min="0" step="0.01" placeholder="Unit cost (KES)" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
              </div>
              <button className="w-full rounded-lg border border-line px-3 py-2 font-semibold" onClick={addLine}>Add line</button>
              {draft.length > 0 && (
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {draft.map((d) => (
                    <li key={d.productId} className="flex justify-between px-3 py-2">
                      <span>{d.name} × {d.quantity}</span>
                      <button className="text-xs text-red-600" onClick={() => setDraft(draft.filter((x) => x.productId !== d.productId))}>Remove</button>
                    </li>
                  ))}
                  <li className="num flex justify-between px-3 py-2 font-semibold"><span>Total</span><span>{formatKes(draftTotal)}</span></li>
                </ul>
              )}
              <button className="btn-primary w-full" disabled={!supplierId || draft.length === 0} onClick={createOrder}>Raise order</button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
