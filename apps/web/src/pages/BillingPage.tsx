import { formatKes, PLANS, type BillingCycle, type SelfServePlan } from "@kpos/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Card, Note, useLoad } from "./ui";

type Price = { plan: SelfServePlan; cycle: BillingCycle; name: string; amountCents: number; branches: number | null; products: number | null };
type Payment = { id: string; plan: SelfServePlan; cycle: BillingCycle; amount_cents: string; status: string; reference: string | null; paid_until: string | null; source: string; created_at: string };
type Billing = {
  billed: boolean; state?: { kind: "TRIAL" | "ACTIVE" | "GRACE" | "LAPSED"; endsAt: string; daysLeft: number };
  plan?: keyof typeof PLANS | null; nextPlan?: SelfServePlan | null; cycle?: BillingCycle | null; phone?: string | null; prices?: Price[]; payments?: Payment[];
};

const date = (s: string) => new Date(s).toLocaleDateString("en-KE", { dateStyle: "medium" });
const POLL_MS = 3000;
const POLL_FOR_MS = 2 * 60_000;

/** The owner chooses a plan and pays BiasharaPOS by M-Pesa, or saves their choice for the automatic prompt. */
export function BillingPage() {
  const b = useLoad<Billing>("/billing", { billed: false });
  const [plan, setPlan] = useState<SelfServePlan>("STARTER");
  const [cycle, setCycle] = useState<BillingCycle>("MONTHLY");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const seeded = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // Fill the form once from what's saved, without overwriting anything typed later.
  useEffect(() => {
    if (seeded.current || !b.data.billed) return;
    seeded.current = true;
    if (b.data.nextPlan) setPlan(b.data.nextPlan);
    if (b.data.cycle) setCycle(b.data.cycle);
    if (b.data.phone) setPhone(`0${b.data.phone.slice(3)}`);
  }, [b.data]);

  const { state } = b.data;
  if (!b.data.billed) return <Card title="Billing"><Note msg={b.msg} /><p className="text-sm text-muted">This business isn't billed for BiasharaPOS.</p></Card>;
  const prices = b.data.prices ?? [];
  const price = prices.find((p) => p.plan === plan && p.cycle === cycle);
  const body = () => JSON.stringify({ plan, cycle, phone: phone.trim() });

  const watch = (id: string, startedAt: number) => {
    timer.current = setTimeout(async () => {
      const p = await api<{ status: string; reference: string | null; paid_until: string | null }>(`/billing/payments/${id}`).catch(() => null);
      if (p?.status === "CONFIRMED") {
        setResult({ ok: true, text: `Payment received${p.reference ? ` (${p.reference})` : ""}. You're paid up${p.paid_until ? ` to ${date(p.paid_until)}` : ""}.` });
        setBusy(false);
        b.reload();
        return;
      }
      if (p?.status === "FAILED") { setResult({ ok: false, text: "The M-Pesa payment didn't go through. You weren't charged. Please try again." }); setBusy(false); return; }
      if (p?.status === "REVIEW") { setResult({ ok: false, text: "We received a different amount than expected. Please contact BiasharaPOS support." }); setBusy(false); return; }
      if (Date.now() - startedAt > POLL_FOR_MS) {
        setResult({ ok: false, text: "Still waiting for M-Pesa. If you entered your PIN, this page will update once it's confirmed: refresh in a few minutes. Don't pay again yet." });
        setBusy(false);
        return;
      }
      watch(id, startedAt);
    }, POLL_MS);
  };

  const pay = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api<{ paymentId: string; amountCents: number }>("/billing/pay", { method: "POST", body: body() });
      setResult({ ok: true, text: `M-Pesa prompt for ${formatKes(r.amountCents)} sent to ${phone}. Enter your PIN on your phone.` });
      watch(r.paymentId, Date.now());
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setResult(null);
    try {
      await api("/billing/plan", { method: "PUT", body: body() });
      setResult({ ok: true, text: `Saved. We'll send the M-Pesa prompt to ${phone} on the last day of your ${state?.kind === "TRIAL" ? "trial" : "period"}.` });
      b.reload();
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const summary = !state ? "" :
    state.kind === "TRIAL" ? `Free trial until ${date(state.endsAt)} (${state.daysLeft} day${state.daysLeft === 1 ? "" : "s"} left).`
    : state.kind === "ACTIVE" ? `${b.data.plan ? PLANS[b.data.plan].name : "Subscription"}, paid up to ${date(state.endsAt)}.`
    : state.kind === "GRACE" ? `Your subscription ended on ${date(state.endsAt)}. Pay now to avoid the app becoming read-only.`
    : "Your account is read-only: you can view and export your records. Pay to carry on selling. Any sales waiting on your till will sync once paid.";

  return (
    <div className="grid max-w-3xl gap-6">
      <Card title="Your subscription">
        <Note msg={b.msg} />
        <p className="text-sm">{summary}</p>
      </Card>
      <Card title="Choose a plan">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void pay(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            {(["STARTER", "COMMERCIAL"] as const).map((p) => (
              <label key={p} className={`cursor-pointer rounded-xl border p-4 ${plan === p ? "border-primary bg-primary/5" : "border-line"}`}>
                <input type="radio" name="plan" className="sr-only" checked={plan === p} onChange={() => setPlan(p)} />
                <p className="font-display font-bold">{PLANS[p].name}</p>
                <p className="mt-1 text-xs text-muted">Up to {PLANS[p].branches} branch{PLANS[p].branches === 1 ? "" : "es"} and {PLANS[p].products.toLocaleString("en-KE")} products</p>
              </label>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {(["MONTHLY", "ANNUAL"] as const).map((c) => {
              const amount = prices.find((x) => x.plan === plan && x.cycle === c)?.amountCents;
              return (
                <label key={c} className={`cursor-pointer rounded-xl border p-4 ${cycle === c ? "border-primary bg-primary/5" : "border-line"}`}>
                  <input type="radio" name="cycle" className="sr-only" checked={cycle === c} onChange={() => setCycle(c)} />
                  <p className="font-semibold">{c === "ANNUAL" ? "Yearly" : "Monthly"}</p>
                  <p className="num text-sm text-muted">{amount === undefined ? "Unavailable" : `${formatKes(amount)} ${c === "ANNUAL" ? "per year" : "per month"}`}</p>
                </label>
              );
            })}
          </div>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="M-Pesa number, e.g. 0712345678" inputMode="tel" pattern="(\+?254|0)(7|1)[0-9]{8}" title="A Kenyan phone number, e.g. 0712345678" required className="input" />
          <p className="text-xs text-muted">M-Pesa always asks for your PIN, so nothing is ever taken without you approving it. Payment adds to any time you have left.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <button disabled={busy || !price} className="btn-primary w-full disabled:opacity-60">{busy ? "Working…" : price ? `Pay ${formatKes(price.amountCents)} now` : "Unavailable"}</button>
            <button type="button" disabled={busy || !price || !phone.trim()} onClick={() => void save()} className="min-h-12 w-full rounded-lg border border-line px-4 font-semibold hover:bg-surface disabled:opacity-60">Prompt me when it's due</button>
          </div>
          {result && <p role="status" className={`rounded-lg bg-surface p-3 text-sm ${result.ok ? "" : "font-semibold text-critical"}`}>{result.text}</p>}
        </form>
      </Card>
      <Card title="Payment history">
        <ul className="divide-y divide-line text-sm">
          {(b.data.payments ?? []).map((p) => (
            <li key={p.id} className="flex flex-wrap justify-between gap-2 py-2">
              <span>{PLANS[p.plan].name}, {p.cycle === "ANNUAL" ? "yearly" : "monthly"}{p.reference ? ` · ${p.reference}` : ""}<span className="block text-xs text-muted">{date(p.created_at)}{p.status === "PENDING" ? " · waiting for M-Pesa" : p.status === "REVIEW" ? " · needs checking" : ""}</span></span>
              <span className="num font-semibold">{formatKes(Number(p.amount_cents))}</span>
            </li>
          ))}
          {!(b.data.payments ?? []).length && <li className="py-4 text-center text-muted">No payments yet.</li>}
        </ul>
      </Card>
    </div>
  );
}
