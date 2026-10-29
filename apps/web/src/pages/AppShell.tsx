import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { api, session } from "../api";

type Me = { user: { name: string; role: string }; business: { name: string } };
const NAV = [
  { to: "/", label: "Dashboard" },
  { to: "/team", label: "Team & branches" },
];
const SOON = ["POS Till", "Sales & Invoices", "Customers", "Inventory", "Suppliers", "Reports", "eTIMS", "Payments"];

export function AppShell() {
  const [me, setMe] = useState<Me | null>(null);
  const nav = useNavigate();
  useEffect(() => {
    api<Me>("/me").then(setMe).catch(() => { session.clear(); nav("/login"); });
  }, [nav]);

  async function logout() {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    session.clear();
    nav("/login");
  }

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-64 shrink-0 flex-col bg-navy p-4 text-slate-300 md:flex">
        <span className="mb-6 px-3 font-display text-xl font-bold text-white">Biashara<span className="text-primary">POS</span></span>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end className={({ isActive }) => `rounded-lg px-3 py-3 ${isActive ? "bg-primary text-white" : "hover:bg-white/5"}`}>{n.label}</NavLink>
        ))}
        <p className="mt-6 px-3 text-xs uppercase tracking-wide text-slate-500">Coming next</p>
        {SOON.map((s) => <span key={s} className="px-3 py-2 text-sm text-slate-500">{s}</span>)}
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-line bg-card px-6">
          <div>
            <p className="font-display font-bold">{me?.business.name ?? "…"}</p>
            <p className="text-xs text-muted">{me ? `${me.user.name} · ${me.user.role}` : ""}</p>
          </div>
          <button onClick={logout} className="text-sm text-muted hover:text-ink">Sign out</button>
        </header>
        <main className="flex-1 p-6"><Outlet /></main>
      </div>
    </div>
  );
}
