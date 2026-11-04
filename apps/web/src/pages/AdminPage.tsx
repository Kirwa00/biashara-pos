import { formatKes } from "@kpos/shared";
import { useState } from "react";
import { api, support } from "../api";
import { Card, Note, useLoad } from "./ui";

type Business = {
  id: string; name: string; status: string; phone: string | null; kra_pin: string | null; created_at: string;
  owner_email: string | null; owner_name: string | null; users: number; branches: number; documents_30d: number; sales_30d_cents: string; last_activity: string | null;
  plan: string | null; billing_cycle: string | null; trial_ends_at: string; paid_until: string | null;
};
type Action = { id: string; admin_email: string; action: string; business_name: string | null; created_at: string };

const TONE: Record<string, string> = { TRIAL: "bg-sky-50 text-sky-700", ACTIVE: "bg-emerald-50 text-emerald-700", SUSPENDED: "bg-red-50 text-critical" };
const day = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-KE", { dateStyle: "medium" }) : "—");

/** Platform console for SUPER_ADMIN_EMAILS: every tenant, suspend/reactivate, and a read-only support view. */
export function AdminPage() {
  const list = useLoad<Business[]>("/admin/businesses", []);
  const actions = useLoad<Action[]>("/admin/actions", []);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  if (list.msg === "Not allowed") return <Card title="Platform admin"><p className="text-sm text-muted">This page is for BiasharaPOS platform admins.</p></Card>;

  const setStatus = async (b: Business, to: "suspend" | "reactivate") => {
    if (to === "suspend" && !confirm(`Suspend ${b.name}? Their team is signed out within 15 minutes and can't sign in until reactivated.`)) return;
    try {
      await api(`/admin/businesses/${b.id}/${to}`, { method: "POST", body: "{}" });
      setMsg(`${b.name} ${to === "suspend" ? "suspended" : "reactivated"}.`);
      list.reload(); actions.reload();
    } catch (e) { setMsg((e as Error).message); }
  };
  /** Enterprise deals, bank or cash payments, and free pilots. */
  const setSubscription = async (b: Business) => {
    const plan = prompt(`Plan for ${b.name}: STARTER, COMMERCIAL or ENTERPRISE`, b.plan ?? "ENTERPRISE")?.trim().toUpperCase();
    if (!plan) return;
    const cycle = prompt("Billing: MONTHLY or ANNUAL", b.billing_cycle ?? "ANNUAL")?.trim().toUpperCase();
    if (!cycle) return;
    const paidUntil = prompt("Paid until (YYYY-MM-DD)", (b.paid_until ?? new Date().toISOString()).slice(0, 10))?.trim();
    if (!paidUntil) return;
    try {
      await api(`/admin/businesses/${b.id}/subscription`, { method: "POST", body: JSON.stringify({ plan, cycle, paidUntil }) });
      setMsg(`${b.name}: ${plan}, paid until ${paidUntil}.`);
      list.reload(); actions.reload();
    } catch (e) { setMsg((e as Error).message); }
  };
  const view = async (b: Business) => {
    try {
      const r = await api<{ accessToken: string }>(`/admin/businesses/${b.id}/impersonate`, { method: "POST", body: "{}" });
      support.start(r.accessToken);
      window.location.href = "/";
    } catch (e) { setMsg((e as Error).message); }
  };

  const needle = q.trim().toLowerCase();
  const shown = list.data.filter((b) => !needle || [b.name, b.owner_email, b.phone, b.kra_pin].some((v) => v?.toLowerCase().includes(needle)));
  const count = (s: string) => list.data.filter((b) => b.status === s).length;

  return (
    <div className="space-y-4">
      <Note msg={msg || list.msg} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([["Businesses", list.data.length], ["Trial", count("TRIAL")], ["Active", count("ACTIVE")], ["Suspended", count("SUSPENDED")]] as const).map(([k, v]) => (
          <div key={k} className="rounded-xl border border-line bg-card p-4"><p className="text-xs uppercase text-muted">{k}</p><p className="num font-display text-2xl font-bold">{v}</p></div>
        ))}
      </div>
      <Card title="Businesses">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, owner email, phone or KRA PIN" className="input mb-3" />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Business</th><th>Owner</th><th>Status</th><th className="text-right">Users</th><th className="text-right">Sales (30 days)</th><th>Last active</th><th /></tr></thead>
            <tbody>
              {shown.map((b) => (
                <tr key={b.id} className="border-t border-line">
                  <td className="py-2"><p className="font-medium">{b.name}</p><p className="text-xs text-muted">Joined {day(b.created_at)}{b.kra_pin ? ` · ${b.kra_pin}` : ""}</p></td>
                  <td><p>{b.owner_name ?? "—"}</p><p className="text-xs text-muted">{b.owner_email}</p></td>
                  <td><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TONE[b.status]}`}>{b.status}</span><p className="mt-1 text-xs text-muted">{b.plan ?? "No plan"}, {b.paid_until ? `paid to ${day(b.paid_until)}` : `trial to ${day(b.trial_ends_at)}`}</p></td>
                  <td className="num text-right">{b.users}</td>
                  <td className="num text-right">{formatKes(Number(b.sales_30d_cents))}<p className="text-xs text-muted">{b.documents_30d} docs</p></td>
                  <td className="text-xs">{day(b.last_activity)}</td>
                  <td className="space-x-2 whitespace-nowrap text-right text-xs font-semibold">
                    <button onClick={() => view(b)} className="text-primary hover:underline">View as owner</button>
                    <button onClick={() => setSubscription(b)} className="text-primary hover:underline">Subscription</button>
                    {b.status === "SUSPENDED"
                      ? <button onClick={() => setStatus(b, "reactivate")} className="text-primary hover:underline">Reactivate</button>
                      : <button onClick={() => setStatus(b, "suspend")} className="text-critical hover:underline">Suspend</button>}
                  </td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={7} className="py-6 text-center text-muted">No businesses match.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Admin activity">
        <ul className="divide-y divide-line text-sm">
          {actions.data.map((a) => (
            <li key={a.id} className="flex justify-between gap-3 py-2"><span><strong>{a.admin_email}</strong> {a.action} {a.business_name ?? ""}</span><span className="text-xs text-muted">{new Date(a.created_at).toLocaleString("en-KE")}</span></li>
          ))}
          {!actions.data.length && <li className="py-4 text-center text-muted">No admin actions yet.</li>}
        </ul>
      </Card>
    </div>
  );
}
