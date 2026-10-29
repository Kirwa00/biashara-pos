import { computeLine, formatKes, toCents, unitPrice, type TaxCode } from "@kpos/shared";
import { useState } from "react";
import { api } from "../api";
import { Card, Note, useLoad, type Product } from "./ui";

type Line = { product: Product; quantity: number };

export function TillPage() {
  const [q, setQ] = useState("");
  const results = useLoad<Product[]>(`/products?q=${encodeURIComponent(q)}`, []);
  const [cart, setCart] = useState<Line[]>([]);
  const [method, setMethod] = useState("CASH");
  const [ref, setRef] = useState("");
  const [msg, setMsg] = useState("");
  const add = (p: Product) => setCart((c) => { const i = c.findIndex((l) => l.product.id === p.id); return i < 0 ? [...c, { product: p, quantity: 1 }] : c.map((l, j) => (j === i ? { ...l, quantity: l.quantity + 1 } : l)); });
  const lineTotal = ({ product: p, quantity }: Line) => computeLine({ quantity, taxCode: p.tax_code as TaxCode, priceIncludesTax: p.price_includes_tax,
    unitPriceCents: unitPrice({ retailPriceCents: Number(p.retail_price_cents), wholesalePriceCents: p.wholesale_price_cents == null ? null : Number(p.wholesale_price_cents), wholesaleMinQty: p.wholesale_min_qty == null ? null : Number(p.wholesale_min_qty) }, quantity) }).totalCents;
  const estimate = cart.reduce((s, l) => s + lineTotal(l), 0);
  async function pay(amount: string) {
    try {
      const doc = await api<{ number: number; total_cents: string }>("/documents", { method: "POST", body: JSON.stringify({
        type: "SALE", idempotencyKey: crypto.randomUUID(), lines: cart.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
        payments: [{ method, amountCents: amount ? toCents(amount) : estimate, reference: ref || undefined }] }) });
      setMsg(`Sale #${doc.number} — ${formatKes(Number(doc.total_cents))}`); setCart([]); setRef("");
    } catch (e) { setMsg((e as Error).message); }
  }
  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card title="Products" className="xl:col-span-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Scan barcode or search" autoFocus className="input mb-4" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{results.data.slice(0, 40).map((p) => (
          <button key={p.id} onClick={() => add(p)} className="rounded-lg border border-line p-3 text-left hover:bg-surface"><div className="font-medium">{p.name}</div><div className="num text-sm text-muted">{formatKes(Number(p.retail_price_cents))}</div></button>))}</div>
      </Card>
      <Card title="Cart">
        <Note msg={msg} />
        {cart.map((l) => (
          <div key={l.product.id} className="flex items-center gap-2 border-b border-line py-2 text-sm">
            <span className="flex-1">{l.product.name}</span>
            <input type="number" min={0} value={l.quantity} onChange={(e) => setCart((c) => c.map((x) => (x === l ? { ...x, quantity: Number(e.target.value) } : x)).filter((x) => x.quantity > 0))} className="input w-20" />
          </div>))}
        <p className="my-4 text-right font-display text-2xl font-bold">{formatKes(estimate)}</p>
        <select value={method} onChange={(e) => setMethod(e.target.value)} className="input mb-3"><option value="CASH">Cash</option><option value="MPESA">M-Pesa (code)</option><option value="CARD">Card</option></select>
        {method !== "CASH" && <input value={ref} onChange={(e) => setRef(e.target.value.toUpperCase())} placeholder="Transaction code" className="input mb-3" />}
        <button disabled={!cart.length} onClick={() => pay("")} className="btn-primary w-full">Charge</button>
      </Card>
    </div>
  );
}
