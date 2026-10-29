import { formatKes, toCents } from "@kpos/shared";
import { useEffect, useState } from "react";
import { api } from "../api";

type Customer = { id: string; name: string; phone: string | null; kra_pin: string | null; price_tier: string; credit_limit_cents: string; payment_terms_days: number };

export function CustomersPage() {
  const [items, setItems] = useState<Customer[]>([]);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const load = (query = q) => api<Customer[]>(`/customers${query ? `?q=${encodeURIComponent(query)}` : ""}`).then(setItems).catch((e: Error) => setMsg(e.message));
  useEffect(() => { load(""); }, []);

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    try {
      await api("/customers", {
        method: "POST",
        body: JSON.stringify({
          name: f.name, phone: f.phone || undefined, email: f.email || undefined, kraPin: f.kraPin ? f.kraPin.toUpperCase() : undefined,
          priceTier: f.priceTier, creditLimitCents: f.credit ? toCents(f.credit) : 0, paymentTermsDays: Number(f.terms || 0),
        }),
      });
      form.reset();
      setMsg("Customer added");
      load();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <section className="rounded-xl border border-line bg-card p-5 xl:col-span-2">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 className="font-display text-lg font-bold">Customers</h2>
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} placeholder="Search name, phone or KRA PIN" className="input max-w-xs" />
        </div>
        {msg && <p className="mb-3 rounded-lg bg-surface p-3 text-sm">{msg}</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2">Name</th><th>Phone</th><th>KRA PIN</th><th>Tier</th><th className="text-right">Credit limit</th><th className="text-right">Terms</th></tr></thead>
            <tbody>{items.map((c) => (
              <tr key={c.id} className="border-t border-line">
                <td className="py-3 font-medium">{c.name}</td><td>{c.phone ?? "—"}</td><td>{c.kra_pin ?? "—"}</td><td>{c.price_tier}</td>
                <td className="num text-right">{formatKes(Number(c.credit_limit_cents))}</td><td className="text-right">{c.payment_terms_days} days</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
      <form onSubmit={add} className="space-y-3 rounded-xl border border-line bg-card p-5">
        <h2 className="font-display text-lg font-bold">Add customer</h2>
        <input name="name" placeholder="Name / business" required className="input" />
        <input name="phone" placeholder="Phone 07…" inputMode="tel" className="input" />
        <input name="email" type="email" placeholder="Email" className="input" />
        <input name="kraPin" placeholder="KRA PIN (A123456789B)" className="input" />
        <select name="priceTier" className="input"><option value="RETAIL">Retail prices</option><option value="WHOLESALE">Wholesale prices</option></select>
        <div className="grid grid-cols-2 gap-3"><input name="credit" placeholder="Credit limit KES" inputMode="decimal" className="input" /><input name="terms" placeholder="Terms (days)" inputMode="numeric" className="input" /></div>
        <button className="btn-primary w-full">Save customer</button>
      </form>
    </div>
  );
}
