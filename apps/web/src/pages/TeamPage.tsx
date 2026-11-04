import { useEffect, useState } from "react";
import { ROLE_LABELS, type Role } from "@kpos/shared";
import { api } from "../api";

type User = { id: string; name: string; email: string; role: string; is_active: boolean };
type Branch = { id: string; name: string; code: string };

export function TeamPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [error, setError] = useState("");
  const load = () => {
    api<User[]>("/users").then(setUsers).catch((e: Error) => setError(e.message));
    api<Branch[]>("/branches").then(setBranches).catch(() => {});
  };
  useEffect(load, []);

  async function update(u: User, change: { role?: string; isActive?: boolean }) {
    try {
      await api(`/users/${u.id}`, { method: "PATCH", body: JSON.stringify(change) });
      setError("");
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function resetPassword(u: User) {
    const password = prompt(`New password for ${u.name} (10+ characters). They will be signed out of any open session.`);
    if (!password) return;
    try {
      await api(`/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ password }) });
      setError(`Password changed for ${u.name}. Give it to them directly.`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function addUser(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      await api("/users", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset();
      setError("");
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <section className="rounded-xl border border-line bg-card p-5 lg:col-span-2">
        <h2 className="mb-4 font-display text-lg font-bold">Team</h2>
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Name</th><th>Email</th><th>Role</th><th className="text-right">Access</th></tr></thead>
          <tbody>{users.map((u) => (
            <tr key={u.id} className={`border-t border-line ${u.is_active ? "" : "opacity-50"}`}>
              <td className="py-3">{u.name}</td><td>{u.email}</td>
              <td>{u.role === "OWNER" ? ROLE_LABELS.OWNER : (
                <select value={u.role} onChange={(e) => update(u, { role: e.target.value })} className="rounded border border-line bg-white px-2 py-1 text-xs">
                  {(["MANAGER", "ACCOUNTANT", "CASHIER"] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
              )}</td>
              <td className="space-x-3 whitespace-nowrap text-right">{u.role !== "OWNER" && <button onClick={() => resetPassword(u)} className="text-xs font-semibold text-primary hover:underline">Reset password</button>}{u.role !== "OWNER" && (
                <button onClick={() => update(u, { isActive: !u.is_active })} className={`text-xs font-semibold ${u.is_active ? "text-critical" : "text-primary"} hover:underline`}>
                  {u.is_active ? "Switch off" : "Switch on"}
                </button>
              )}</td>
            </tr>
          ))}</tbody>
        </table>
        <h3 className="mb-2 mt-6 font-display font-bold">Branches</h3>
        <ul className="text-sm">{branches.map((b) => <li key={b.id}>{b.name} <span className="text-muted">({b.code})</span></li>)}</ul>
      </section>
      <form onSubmit={addUser} className="space-y-3 rounded-xl border border-line bg-card p-5">
        <h2 className="font-display text-lg font-bold">Add staff</h2>
        <input name="name" placeholder="Full name" required className="input" />
        <input name="email" type="email" placeholder="Email (they sign in with this)" required className="input" />
        <select name="role" className="input"><option value="CASHIER">{ROLE_LABELS.CASHIER}</option><option value="MANAGER">{ROLE_LABELS.MANAGER}</option><option value="ACCOUNTANT">{ROLE_LABELS.ACCOUNTANT}</option></select>
        <p className="text-xs text-muted"><strong>Cashier / Teller:</strong> sells on the till and makes quotations and invoices, nothing else. <strong>Accountant:</strong> invoices, payments and reports. <strong>Manager:</strong> also stock, products and approvals. Only the owner manages staff, settings and billing.</p>
        <input name="password" type="password" placeholder="Temporary password (10+ chars)" required className="input" />
        {error && <p className="text-sm text-critical">{error}</p>}
        <button className="btn-primary w-full">Add</button>
      </form>
    </div>
  );
}
