import { useEffect, useState } from "react";
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
              <td>{u.role === "OWNER" ? u.role : (
                <select value={u.role} onChange={(e) => update(u, { role: e.target.value })} className="rounded border border-line bg-white px-2 py-1 text-xs">
                  {["MANAGER", "ACCOUNTANT", "CASHIER"].map((r) => <option key={r}>{r}</option>)}
                </select>
              )}</td>
              <td className="text-right">{u.role !== "OWNER" && (
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
        <input name="email" type="email" placeholder="Email" required className="input" />
        <select name="role" className="input"><option>CASHIER</option><option>MANAGER</option><option>ACCOUNTANT</option></select>
        <input name="password" type="password" placeholder="Temporary password (10+ chars)" required className="input" />
        {error && <p className="text-sm text-critical">{error}</p>}
        <button className="btn-primary w-full">Add</button>
      </form>
    </div>
  );
}
