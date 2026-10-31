import { useEffect, useState } from "react";
import { api } from "../api";

/** Small helpers shared by the prototype pages. */
/** `cache` keeps the last good response in localStorage and serves it when the device is offline. */
export function useLoad<T>(path: string, init: T, cache?: string) {
  const [data, setData] = useState<T>(init);
  const [msg, setMsg] = useState("");
  const reload = () =>
    api<T>(path)
      .then((d) => { setData(d); if (cache) localStorage.setItem(cache, JSON.stringify(d)); })
      .catch((e: Error) => {
        const hit = cache && e instanceof TypeError ? localStorage.getItem(cache) : null;
        if (hit) setData(JSON.parse(hit) as T);
        setMsg(hit ? "Offline: showing the last saved copy." : e.message);
      });
  useEffect(() => { reload(); }, [path]);
  return { data, reload, msg, setMsg };
}
export const formData = (e: React.FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
};
export const Card = ({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) => (
  <section className={`rounded-xl border border-line bg-card p-5 ${className}`}><h2 className="mb-4 font-display text-lg font-bold">{title}</h2>{children}</section>
);
export const Note = ({ msg }: { msg: string }) => (msg ? <p className="mb-3 rounded-lg bg-surface p-3 text-sm">{msg}</p> : null);
export type Product = { id: string; sku: string; name: string; retail_price_cents: string; wholesale_price_cents: string | null; wholesale_min_qty: string | null; tax_code: string; price_includes_tax: boolean };
export type Customer = { id: string; name: string; price_tier?: "RETAIL" | "WHOLESALE" };
export const ProductSelect = ({ products, name = "productId" }: { products: Product[]; name?: string }) => (
  <select name={name} required className="input"><option value="">Product…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}</select>
);
