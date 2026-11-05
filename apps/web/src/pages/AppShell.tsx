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

/** Phone tab bar: the first four of these the user may open, then More for everything else. */
const TABS: { to: string; label: string; icon: string }[] = [
  { to: "/", label: "Home", icon: "M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10" },
  { to: "/till", label: "Till", icon: "M4 7h16v13H4zM8 7V4h8v3M8 12h8M8 16h5" },
  { to: "/sales", label: "Sales", icon: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" },
  { to: "/inventory", label: "Stock", icon: "M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8" },
  { to: "/shifts", label: "Shift", icon: "M12 7v5l3 3M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
  { to: "/customers", label: "Customers", icon: "M16 11a4 4 0 10-8 0 4 4 0 008 0zM4 21a8 8 0 0116 0" },
];
const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

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
    <div className={`flex flex-wrap items-center justify-between gap-3 px-4 py-2 text-sm md:px-6 ${urgent ? "bg-red-50 text-critical" : "bg-amber-100 text-amber-900"}`}>
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
  const [menuOpen, setMenuOpen] = useState(false);
  const nav = useNavigate();
  const { pathname } = useLocation();
  const canSee = (p: Permission) => !!me && can(me.user.role as Role, p);
  // Typing a page's address is refused too: send people to the first page they can use.
  const page = NAV.find((n) => n.to === pathname);
  const homePage = NAV.find((n) => canSee(n.need))?.to ?? "/till";
  const links = [...NAV.filter((n) => canSee(n.need)), ...(me?.billing && me.user.role === "OWNER" ? [{ to: "/billing", label: "Billing" }] : []), ...(me?.isSuperAdmin ? [{ to: "/admin", label: "Platform Admin" }] : [])];
  const tabs = TABS.filter((t) => links.some((l) => l.to === t.to)).slice(0, 4);
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition ${isActive ? "bg-primary text-white shadow-sm" : "hover:bg-white/5 hover:text-white"}`;

  // The menu closes itself when a link is followed.
  useEffect(() => setMenuOpen(false), [pathname]);

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
    nav(me?.user.role === "CASHIER" ? "/till-login" : "/login");
  }

  return (
    <div className="flex min-h-dvh bg-surface">
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
          {links.map((n) => <NavLink key={n.to} to={n.to} end={n.to === "/"} className={linkClass}>{n.label}</NavLink>)}
        </nav>

        {/* Sidebar Footer */}
        <div className="mt-4 border-t border-slate-800 pt-4 px-3 text-xs text-slate-400 space-y-1">
          {canSee("reports.view") && <NavLink to="/etims" className="hover:text-white">eTIMS status: Tax Center</NavLink>}
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex flex-1 flex-col min-w-0">
        <header className="safe-top sticky top-0 z-20 flex shrink-0 items-center justify-between gap-3 border-b border-line bg-card px-4 py-2.5 md:static md:h-16 md:px-6 md:py-0">
          <div className="flex min-w-0 items-center gap-4">
            <div className="min-w-0">
              <p className="truncate font-display font-bold leading-tight text-ink">{me?.business.name ?? "Biashara"}</p>
              <p className="truncate text-xs text-muted">
                {me ? `${me.user.name} · ${ROLE_LABELS[me.user.role as Role] ?? me.user.role}` : ""}
                <span className="hidden md:inline">{me?.business.kra_pin ? ` · PIN: ${me.business.kra_pin}` : ""}</span>
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 md:gap-3">
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
              <button onClick={() => install.prompt().finally(() => setInstall(null))} className="rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-active transition md:py-1">
                Install app
              </button>
            )}

            {canSee("reports.view") && <NavLink to="/notifications" aria-label={`${unread} unread notifications`} className="relative rounded-full border border-line px-3 py-1.5 text-xs font-medium md:py-1 text-muted hover:bg-surface hover:text-ink transition">
              Alerts
              {unread > 0 && <span className="num absolute -right-1.5 -top-1.5 rounded-full bg-critical px-1.5 text-[10px] font-bold text-white">{unread}</span>}
            </NavLink>}

            {/* Offline / Online indicator */}
            <span className="hidden lg:inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Online
            </span>

            <button onClick={logout} className="hidden rounded-lg border border-line md:inline-flex px-3 py-1.5 text-xs font-semibold text-muted hover:bg-surface hover:text-ink transition">
              Sign out
            </button>
          </div>
        </header>

        {me?.supportSession && (
          <div className="flex items-center justify-between gap-3 bg-amber-100 px-4 py-2 text-sm text-amber-900 md:px-6">
            <span><strong>Support view</strong> of {me.business.name}: read-only, ends after 15 minutes.</span>
            <button onClick={() => { support.exit(); window.location.href = "/admin"; }} className="rounded-lg bg-amber-900 px-3 py-1 text-xs font-semibold text-white">Exit support view</button>
          </div>
        )}
        {me?.billing && <BillingBanner billing={me.billing} owner={me.user.role === "OWNER"} />}
        <main className="flex-1 overflow-y-auto p-4 pb-24 md:p-6">
          <Suspense fallback={<Loading />}>
            {me && page && !canSee(page.need) ? <Navigate to={homePage} replace /> : <Outlet />}
          </Suspense>
        </main>
      </div>

      {/* Phone navigation: the sidebar is hidden below md. */}
      <nav aria-label="Main" className="safe-bottom fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-card print:hidden md:hidden">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.to === "/"} className={({ isActive }) => `flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${isActive ? "text-primary" : "text-muted"}`}>
            <Icon d={t.icon} />
            {t.label}
          </NavLink>
        ))}
        <button onClick={() => setMenuOpen(true)} aria-expanded={menuOpen} className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${menuOpen ? "text-primary" : "text-muted"}`}>
          <Icon d="M4 7h16M4 12h16M4 17h16" />
          More
        </button>
      </nav>

      {menuOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button aria-label="Close menu" onClick={() => setMenuOpen(false)} className="absolute inset-0 bg-navy/60" />
          <div className="safe-top safe-bottom absolute inset-y-0 right-0 flex w-72 max-w-[85vw] flex-col bg-navy p-4 text-slate-300">
            <div className="mb-3 flex items-center justify-between px-3">
              <span className="font-display text-lg font-bold text-white">Biashara<span className="text-primary">POS</span></span>
              <button onClick={() => setMenuOpen(false)} className="rounded-lg px-2 py-1 text-sm font-semibold hover:text-white">Close</button>
            </div>
            {canSee("shift.open") && (
              <NavLink to="/shifts" className="mb-3 flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2.5 text-xs font-medium">
                <span className={`h-2 w-2 rounded-full ${currentShift ? "bg-primary" : "bg-slate-400"}`} />
                {currentShift ? `Till Shift: ${formatKes(currentShift.expected_cash_cents)}` : "No Shift Open"}
              </NavLink>
            )}
            <nav className="flex-1 space-y-1 overflow-y-auto">
              {links.map((n) => <NavLink key={n.to} to={n.to} end={n.to === "/"} className={linkClass}>{n.label}</NavLink>)}
            </nav>
            <button onClick={logout} className="mt-3 rounded-lg border border-slate-700 px-3 py-2.5 text-sm font-semibold hover:text-white">Sign out</button>
          </div>
        </div>
      )}
    </div>
  );
}
