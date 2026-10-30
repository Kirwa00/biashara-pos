import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { formatKes } from "@kpos/shared";
import { api, session } from "../api";

type Me = {
  user: { name: string; role: string };
  business: { name: string; kra_pin?: string | null };
};

type ShiftSummary = {
  id: string;
  expected_cash_cents: number;
  opened_at: string;
};

const NAV = [
  { to: "/", label: "Overview" },
  { to: "/till", label: "POS Till" },
  { to: "/shifts", label: "Shifts & Cash-Up" },
  { to: "/sales", label: "Sales & Invoices" },
  { to: "/returns", label: "Returns & Credit Notes" },
  { to: "/inventory", label: "Stock & Movements" },
  { to: "/suppliers", label: "Suppliers & POs" },
  { to: "/reports", label: "Financial Reports" },
  { to: "/etims", label: "eTIMS Tax Center" },
  { to: "/products", label: "Products & Catalog" },
  { to: "/customers", label: "Customers & Debtors" },
  { to: "/team", label: "Team & Branches" },
  { to: "/settings/payments", label: "PayHero Settings" },
];

export function AppShell() {
  const [me, setMe] = useState<Me | null>(null);
  const [currentShift, setCurrentShift] = useState<ShiftSummary | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    api<Me>("/me")
      .then(setMe)
      .catch(() => {
        session.clear();
        nav("/login");
      });

    api<ShiftSummary | null>("/shifts/current")
      .then(setCurrentShift)
      .catch(() => {});
  }, [nav]);

  async function logout() {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    session.clear();
    nav("/login");
  }

  return (
    <div className="flex min-h-screen bg-surface">
      {/* Sidebar Navigation */}
      <aside className="hidden w-64 shrink-0 flex-col bg-navy p-4 text-slate-300 md:flex">
        <div className="mb-6 px-3 flex items-center justify-between">
          <span className="font-display text-xl font-bold text-white">
            Biashara<span className="text-primary">POS</span>
          </span>
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase font-bold text-slate-400">
            Kenya
          </span>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                  isActive ? "bg-primary text-white shadow-sm" : "hover:bg-white/5 hover:text-white"
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>

        {/* Sidebar Footer */}
        <div className="mt-4 border-t border-slate-800 pt-4 px-3 text-xs text-slate-400 space-y-1">
          <div className="flex items-center gap-1.5 text-emerald-400">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>eTIMS VSCU Connected</span>
          </div>
          <p className="text-[11px] text-slate-500">KRA-VSCU-7801-NW</p>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex flex-1 flex-col min-w-0">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-line bg-card px-6">
          <div className="flex items-center gap-4">
            <div>
              <p className="font-display font-bold leading-tight text-ink">{me?.business.name ?? "Biashara"}</p>
              <p className="text-xs text-muted">
                {me ? `${me.user.name} · ${me.user.role}` : ""}
                {me?.business.kra_pin ? ` · PIN: ${me.business.kra_pin}` : ""}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Shift Indicator */}
            <NavLink
              to="/shifts"
              className={`hidden sm:inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
                currentShift
                  ? "bg-primary/10 text-primary hover:bg-primary/20"
                  : "bg-surface text-muted hover:bg-line border border-line"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${currentShift ? "bg-primary animate-pulse" : "bg-slate-400"}`} />
              {currentShift ? `Till Shift: ${formatKes(currentShift.expected_cash_cents)}` : "No Shift Open"}
            </NavLink>

            {/* Offline / Online indicator */}
            <span className="hidden lg:inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Online
            </span>

            <button onClick={logout} className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted hover:bg-surface hover:text-ink transition">
              Sign out
            </button>
          </div>
        </header>

        <main className="flex-1 p-6 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
