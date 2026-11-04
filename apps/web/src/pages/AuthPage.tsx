import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, session } from "../api";

const SHOP_CODE_KEY = "kpos.shopCode";
/** Remembered per device so a till only asks for its shop code once. */
const savedShopCode = () => { try { return localStorage.getItem(SHOP_CODE_KEY) ?? ""; } catch { return ""; } };

export function AuthPage({ mode }: { mode: "login" | "register" | "till" }) {
  const nav = useNavigate();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isLogin = mode !== "register";
  const isTill = mode === "till";

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = Object.fromEntries(new FormData(e.currentTarget));
      session.set(await api(`/auth/${mode}`, { method: "POST", body: JSON.stringify(body) }));
      if (isTill) { try { localStorage.setItem(SHOP_CODE_KEY, String(body.shopCode).trim()); } catch { /* the code is just retyped next time */ } }
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
          <h2 className="font-display text-2xl font-bold">{isTill ? "Till sign in" : isLogin ? "Sign in" : "Create your business"}</h2>
          {!isLogin && field("businessName", "Business name")}
          {!isLogin && field("ownerName", "Your name")}
          {isTill && (
            <>
              <label className="block text-sm font-medium">Shop code<input name="shopCode" required defaultValue={savedShopCode()} autoCapitalize="characters" autoComplete="off" className="input mt-1 uppercase" /></label>
              <label className="block text-sm font-medium">Username<input name="username" required autoCapitalize="none" autoComplete="username" className="input mt-1" /></label>
              <label className="block text-sm font-medium">PIN<input name="pin" type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} title="4 digits" required autoComplete="current-password" className="input mt-1" /></label>
            </>
          )}
          {!isTill && field("email", "Email", "email")}
          {!isLogin && field("phone", "Phone (07… or 01…)", "tel")}
          {!isTill && field("password", "Password", "password")}
          {error && <p className="rounded-lg bg-critical/10 p-3 text-sm text-critical">{error}</p>}
          <button className="btn-primary w-full" disabled={busy}>{busy ? "Please wait…" : isLogin ? "Sign in" : "Create account"}</button>
          <p className="text-center text-sm text-muted">
            {isTill ? <>Not a teller? <Link className="text-primary" to="/login">Sign in with email</Link></> : isLogin ? <>Teller? <Link className="text-primary" to="/till-login">Sign in with your PIN</Link> · New here? <Link className="text-primary" to="/register">Create a business</Link></> : <>Have an account? <Link className="text-primary" to="/login">Sign in</Link></>}
          </p>
        </form>
      </main>
    </div>
  );
}
