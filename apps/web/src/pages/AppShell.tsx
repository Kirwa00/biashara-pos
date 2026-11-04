import { Suspense, useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { can, formatKes, ROLE_LABELS, type Permission, type Role } from "@kpos/shared";
import { api, session, support } from "../api";
import { Loading } from "./ui";

type Me = {
  user: { name: string; role: string };
  business: { name: string; kra_pin?: string | null };
  isSuperAdmin?: boolean;
  billing?: { kind: "TRIAL" | "ACTIVE" | "GRACE" | "LAPSED"; endsAt: string; daysLeft: number } | null;
  supportSession?: boolean;
};

type ShiftSummary = {
  id: string;
  expected_cash_cents: number;
  opened_at: string;
};

const NAV: { to: string; label: string; need: Permission }[] = [
  { to: "/", label: "Overview", need: "reports.view" },
  { to: "/till", label: "POS Till", need: "sales.create" },
  { to: "/shifts", label: "Shifts & Cash-Up", need: "shift.open" },
  { to: "/sales", label: "Sales & Invoices", need: "documents.create" },
  { to: "/returns", label: "Returns & Credit Notes", need: "sales.refund" },
  { to: "/inventory", label: "Stock & Movements", need: "stock.view" },
  { to: "/transfers", label: "Branch Transfers", need: "stock.view" },
  { to: "/suppliers", label: "Suppliers & GRNs", need: "stock.view" },
  { to: "/purchase-orders", label: "Purchase Orders", need: "reports.view" },
  { to: "/reports", label: "Financial Reports", need: "reports.view" },
  { to: "/etims", label: "eTIMS Tax Center", need: "reports.view" },
  { to: "/products", label: "Products & Catalog", need: "catalog.manage" },
  { to: "/customers", label: "Customers & Debtors", need: "customers.manage" },
  { to: "/reminders", label: "Payment Reminders", need: "invoices.manage" },
  { to: "/notifications", label: "Notifications", need: "reports.view" },
  { to: "/team", label: "Team & Branches", need: "users.manage" },
  { to: "/settings/payments", label: "PayHero Settings", need: "settings.payments" },
];

/** Quiet until a week before the end, then increasingly plain. Only owners can pay, so everyone else is told who to ask. */
function BillingBanner({ billing, owner }: { billing: NonNullable<Me["billing"]>; owner: boolean }) {
  const { kind, daysLeft } = billing;
  if ((kind === "TRIAL" || kind === "ACTIVE") && daysLeft > 7) return null;
  const left = `${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
  const graceLeft = Math.max(3 + daysLeft, 0);
  const text = kind === "LAPSED" ? "This account is read-only: you can view and export records, but not make sales or changes."
    : kind === "GRACE" ? `The subscription has ended. The app becomes read-only in ${graceLeft} day${graceLeft === 1 ? "" : "s"}.`
    : kind === "TRIAL" ? `Free trial: ${left} left.` : `Subscription renews in ${left}.`;
  const urgent = kind === "LAPSED" || kind === "GRACE";
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 px-6 py-2 text-sm ${urgent ? "bg-red-50 text-critical" : "bg-amber-100 text-amber-900"}`}>
      <span>{text}{owner ? "" : " Ask the business owner to pay."}</span>
      {owner && <NavLink to="/billing" className="rounded-lg bg-navy px-3 py-1 text-xs font-semibold text-white">Open Billing</NavLink>}
    </div>
  );
}

export function AppShell() {
  const [me, setMe] = useState<Me | null>(null);
  const [currentShift, setCurrentShift] = useState<ShiftSummary | null>(null);
  const [unread, setUnread] = useState(0);
  const [install, setInstall] = useState<{ prompt: () => Promise<void> } | null>(null);
  const nav = useNavigate();
  const { pathname } = useLocation();
  const canSee = (p: Permission) => !!me && can(me.user.role as Role, p);
  // Typing a page's address is refused too: send people to the first page they can use.
  const page = NAV.find((n) => n.to === pathname);
  const homePage = NAV.find((n) => canSee(n.need))?.to ?? "/till";

  // Chrome/Edge/Android offer installation once the PWA criteria are met; we surface it as a header button.
  useEffect(() => {
    const offer = (e: Event) => { e.preventDefault(); setInstall(e as unknown as { prompt: () => Promise<void> }); };
    const done = () => setInstall(null);
    window.addEventListener("beforeinstallprompt", offer);
    window.addEventListener("appinstalled", done);
    return () => { window.removeEventListener("beforeinstallprompt", offer); window.removeEventListener("appinstalled", done); };
  }, []);

  // Cashiers can't see notifications (403); the bell just stays at zero.
  useEffect(() => {
    api<{ unread: number }>("/notifications?unread=1").then((n) => setUnread(n.unread)).catch(() => {});
  }, [pathname]);

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
    if (support.active()) { support.exit(); window.location.href = "/admin"; return; }
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
          {[...NAV.filter((n) => canSee(n.need)), ...(me?.billing && me.user.role === "OWNER" ? [{ to: "/billing", label: "Billing" }] : []), ...(me?.isSuperAdmin ? [{ to: "/admin", label: "Platform Admin" }] : [])].map((n) => (
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
          {canSee("reports.view") && <NavLink to="/etims" className="hover:text-white">eTIMS status: Tax Center</NavLink>}
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex flex-1 flex-col min-w-0">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-line bg-card px-6">
          <div className="flex items-center gap-4">
            <div>
              <p className="font-display font-bold leading-tight text-ink">{me?.business.name ?? "Biashara"}</p>
              <p className="text-xs text-muted">
                {me ? `${me.user.name} · ${ROLE_LABELS[me.user.role as Role] ?? me.user.role}` : ""}
                {me?.business.kra_pin ? ` · PIN: ${me.business.kra_pin}` : ""}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Shift Indicator */}
            {canSee("shift.open") && <NavLink
              to="/shifts"
              className={`hidden sm:inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
                currentShift
                  ? "bg-primary/10 text-primary hover:bg-primary/20"
                  : "bg-surface text-muted hover:bg-line border border-line"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${currentShift ? "bg-primary animate-pulse" : "bg-slate-400"}`} />
              {currentShift ? `Till Shift: ${formatKes(currentShift.expected_cash_cents)}` : "No Shift Open"}
            </NavLink>}

            {install && (
              <button onClick={() => install.prompt().finally(() => setInstall(null))} className="hidden sm:inline-flex rounded-full bg-primary px-3 py-1 text-xs font-semibold text-white hover:bg-primary-active transition">
                Install app
              </button>
            )}

            {canSee("reports.view") && <NavLink to="/notifications" aria-label={`${unread} unread notifications`} className="relative rounded-full border border-line px-3 py-1 text-xs font-medium text-muted hover:bg-surface hover:text-ink transition">
              Alerts
              {unread > 0 && <span className="num absolute -right-1.5 -top-1.5 rounded-full bg-critical px-1.5 text-[10px] font-bold text-white">{unread}</span>}
            </NavLink>}

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

        {me?.supportSession && (
          <div className="flex items-center justify-between gap-3 bg-amber-100 px-6 py-2 text-sm text-amber-900">
            <span><strong>Support view</strong> of {me.business.name}: read-only, ends after 15 minutes.</span>
            <button onClick={() => { support.exit(); window.location.href = "/admin"; }} className="rounded-lg bg-amber-900 px-3 py-1 text-xs font-semibold text-white">Exit support view</button>
          </div>
        )}
        {me?.billing && <BillingBanner billing={me.billing} owner={me.user.role === "OWNER"} />}
        <main className="flex-1 p-6 overflow-y-auto">
          <Suspense fallback={<Loading />}>
            {me && page && !canSee(page.need) ? <Navigate to={homePage} replace /> : <Outlet />}
          </Suspense>
        </main>
      </div>
    </div>
  );
}
