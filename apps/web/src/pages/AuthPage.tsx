import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, session } from "../api";

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const nav = useNavigate();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isLogin = mode === "login";

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = Object.fromEntries(new FormData(e.currentTarget));
      session.set(await api(`/auth/${mode}`, { method: "POST", body: JSON.stringify(body) }));
      nav("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const field = (name: string, label: string, type = "text") => (
    <label className="block text-sm font-medium">
      {label}
      <input name={name} type={type} required className="input mt-1" autoComplete={type === "password" ? (isLogin ? "current-password" : "new-password") : undefined} />
    </label>
  );

  return (
    <div className="grid min-h-screen md:grid-cols-2">
      <aside className="hidden flex-col justify-between bg-navy p-10 text-white md:flex">
        <span className="font-display text-2xl font-bold">Biashara<span className="text-primary">POS</span></span>
        <div>
          <h1 className="font-display text-4xl font-bold leading-tight">Sell, get paid and know your numbers.</h1>
          <p className="mt-4 text-slate-300">Sales, invoices, M-Pesa, stock and profit for Kenyan businesses — in one place.</p>
        </div>
        <span className="text-sm text-slate-400">eTIMS-ready · Works on any phone</span>
      </aside>
      <main className="flex items-center justify-center p-6">
        <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
          <h2 className="font-display text-2xl font-bold">{isLogin ? "Sign in" : "Create your business"}</h2>
          {!isLogin && field("businessName", "Business name")}
          {!isLogin && field("ownerName", "Your name")}
          {field("email", "Email", "email")}
          {!isLogin && field("phone", "Phone (07… or 01…)", "tel")}
          {field("password", "Password", "password")}
          {error && <p className="rounded-lg bg-critical/10 p-3 text-sm text-critical">{error}</p>}
          <button className="btn-primary w-full" disabled={busy}>{busy ? "Please wait…" : isLogin ? "Sign in" : "Create account"}</button>
          <p className="text-center text-sm text-muted">
            {isLogin ? <>New here? <Link className="text-primary" to="/register">Create a business</Link></> : <>Have an account? <Link className="text-primary" to="/login">Sign in</Link></>}
          </p>
        </form>
      </main>
    </div>
  );
}
