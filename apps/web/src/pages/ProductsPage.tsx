import { formatKes, toCents } from "@kpos/shared";
import { useEffect, useState } from "react";
import { api } from "../api";

type Product = { id: string; sku: string; barcode: string | null; name: string; category_name: string | null; base_unit: string; tax_code: string; retail_price_cents: string; wholesale_price_cents: string | null; reorder_level: string };
type Category = { id: string; name: string };

export function ProductsPage() {
  const [items, setItems] = useState<Product[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const load = (query = q) => {
    api<Product[]>(`/products?limit=200${query ? `&q=${encodeURIComponent(query)}` : ""}`).then(setItems).catch((e: Error) => setMsg(e.message));
    api<Category[]>("/categories").then(setCats).catch(() => {});
  };
  useEffect(() => load(""), []);

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    try {
      await api("/products", {
        method: "POST",
        body: JSON.stringify({
          sku: f.sku, name: f.name, barcode: f.barcode || undefined, categoryId: f.categoryId || undefined, taxCode: f.taxCode,
          retailPriceCents: toCents(f.retail || "0"), wholesalePriceCents: f.wholesale ? toCents(f.wholesale) : undefined,
          costCents: f.cost ? toCents(f.cost) : 0, reorderLevel: Number(f.reorder || 0),
        }),
      });
      form.reset();
      setMsg("Product added");
      load();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  async function importCsv(file: File) {
    try {
      const res = await fetch("/v1/products/import", { method: "POST", headers: { "content-type": "text/csv", authorization: `Bearer ${JSON.parse(localStorage.getItem("kpos.session") ?? "{}").accessToken}` }, body: await file.text() });
      const out = (await res.json()) as { imported: number; errors?: { row: number; error: string }[]; error?: string };
      setMsg(out.errors?.length ? `Nothing imported. Fix: ${out.errors.slice(0, 5).map((x) => `row ${x.row}: ${x.error}`).join(" | ")}` : out.error ?? `Imported ${out.imported} products`);
      load();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <section className="rounded-xl border border-line bg-card p-5 xl:col-span-2">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 className="font-display text-lg font-bold">Products</h2>
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} placeholder="Search name, SKU or scan barcode" className="input max-w-xs" />
          <label className="btn-primary cursor-pointer">Import CSV<input type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])} /></label>
        </div>
        {msg && <p className="mb-3 rounded-lg bg-surface p-3 text-sm">{msg}</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2">Name</th><th>SKU</th><th>Category</th><th>Tax</th><th className="text-right">Retail</th><th className="text-right">Wholesale</th></tr></thead>
            <tbody>{items.map((p) => (
              <tr key={p.id} className="border-t border-line">
                <td className="py-3 font-medium">{p.name}</td><td className="text-muted">{p.sku}</td><td>{p.category_name ?? "—"}</td><td>{p.tax_code}</td>
                <td className="num text-right">{formatKes(Number(p.retail_price_cents))}</td>
                <td className="num text-right">{p.wholesale_price_cents ? formatKes(Number(p.wholesale_price_cents)) : "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <p className="mt-4 text-xs text-muted">CSV columns: sku, name, category, barcode, unit, tax_code (A exempt, B 16%, C zero-rated, D non-VAT, E 8%), retail_price, wholesale_price, wholesale_min_qty, cost, reorder_level. Prices in KES.</p>
      </section>
      <form onSubmit={add} className="space-y-3 rounded-xl border border-line bg-card p-5">
        <h2 className="font-display text-lg font-bold">Add product</h2>
        <input name="name" placeholder="Name" required className="input" />
        <div className="grid grid-cols-2 gap-3"><input name="sku" placeholder="SKU" required className="input" /><input name="barcode" placeholder="Barcode" className="input" /></div>
        <select name="categoryId" className="input"><option value="">No category</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select name="taxCode" className="input" defaultValue="B"><option value="B">VAT 16%</option><option value="A">Exempt</option><option value="C">Zero-rated</option><option value="E">VAT 8%</option><option value="D">Non-VAT</option></select>
        <div className="grid grid-cols-2 gap-3"><input name="retail" placeholder="Retail KES" required inputMode="decimal" className="input" /><input name="wholesale" placeholder="Wholesale KES" inputMode="decimal" className="input" /></div>
        <div className="grid grid-cols-2 gap-3"><input name="cost" placeholder="Cost KES" inputMode="decimal" className="input" /><input name="reorder" placeholder="Reorder level" inputMode="numeric" className="input" /></div>
        <button className="btn-primary w-full">Save product</button>
      </form>
    </div>
  );
}
