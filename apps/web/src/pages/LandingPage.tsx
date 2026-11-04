import { Link } from "react-router";

/** Public marketing page shown at "/" to signed-out visitors. Plans and prices follow the Stitch pricing design; confirm before launch. */
const questions = [
  ["What have I sold?", "Every sale, quotation and invoice in one place, by day, branch and cashier."],
  ["Who owes me money?", "Customer balances, statements and overdue invoices with the customer's phone number."],
  ["How much cash came in?", "Cash, M-Pesa and card per shift, with X/Z reports and counted-cash variance."],
  ["What stock do I have?", "Live stock per branch, reorder alerts, stock counts and supplier deliveries."],
  ["Am I making a profit?", "Gross profit at weighted-average cost, VAT by month and CSV exports for your accountant."],
] as const;

const features = [
  ["Fast till", "Search or scan, cash, M-Pesa, card or on account. Shifts, cash-up and printable receipts."],
  ["M-Pesa on your own account", "Connect your PayHero account: STK prompts and typed-in M-Pesa codes are matched automatically, so the money goes straight to you."],
  ["Quotes to invoices", "Turn a quotation into an invoice without retyping. Credit limits, statements and returns with credit notes."],
  ["Stock & suppliers", "Stock ledger, counts with manager approval, goods received from suppliers and reorder alerts."],
  ["Keeps selling offline", "Cash and card sales are saved on the device when the internet drops and sync when it's back."],
  ["Roles & branches", "Owner, manager, accountant and cashier roles; staff only see and sell in their branch."],
  ["Your data stays yours", "Each business's data is kept separate, every change is logged, and owners can export everything as CSV."],
  ["eTIMS-ready", "Invoices are built to carry KRA eTIMS details. Direct KRA submission is being added; until then figures are marked as local."],
] as const;

const plans = [
  { name: "Biashara Starter", who: "Single shops, dukas, chemists and neighbourhood supermarkets", price: "3,600", items: ["1 branch, 1 till", "Up to 1,000 products", "Till, shifts, receipts and X/Z reports", "M-Pesa via your PayHero account", "Stock, customers and invoices"], cta: "Start free trial", featured: false },
  { name: "Commercial Wholesale", who: "Distributors, wholesalers and retail chains", price: "14,800", items: ["Up to 5 branches, unlimited tills", "Up to 50,000 products", "Suppliers and goods received", "Customer statements, credit limits and overdue alerts", "Profit and VAT reports, CSV export"], cta: "Start free trial", featured: true },
  { name: "Enterprise", who: "Corporates and chains with more than 5 outlets", price: null, items: ["Unlimited branches", "Onboarding and data import help", "Priority support"], cta: "Start free trial", featured: false },
] as const;

const faqs = [
  ["Do I need a PayHero account?", "Only for M-Pesa prompts and automatic code matching. Each business connects its own PayHero account in Settings → Payments, so payments settle to you, not to us. Cash, card and invoices work without it."],
  ["What happens when the internet goes down?", "If the till is already open, cash and card sales are saved on the device and sent automatically when the connection returns. M-Pesa and credit sales need a connection because they are checked at the time of sale."],
  ["Does it submit to KRA eTIMS?", "Not yet. eTIMS integration is in progress; today the eTIMS page prepares your monthly VAT figures from your own records and clearly marks them as not yet sent to KRA."],
  ["Which devices does it run on?", "Any modern browser on a phone, tablet or computer. On Android it can be installed like an app."],
  ["Can I get my data out?", "Yes. Owners can download their products, customers, sales, payments and stock as CSV at any time."],
] as const;

export function LandingPage() {
  return (
    <div className="bg-surface text-ink">
      <header className="sticky top-0 z-10 border-b border-line bg-white/90 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <span className="font-display text-xl font-bold">Biashara<span className="text-primary">POS</span></span>
          <div className="hidden gap-6 text-sm font-medium text-muted md:flex">
            <a href="#features" className="hover:text-ink">Features</a>
            <a href="#pricing" className="hover:text-ink">Pricing</a>
            <a href="#faq" className="hover:text-ink">FAQ</a>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/login" className="px-3 py-2 text-sm font-semibold hover:text-primary">Sign in</Link>
            <Link to="/register" className="btn-primary min-h-10 text-sm">Start free</Link>
          </div>
        </nav>
      </header>

      <section className="bg-navy text-white">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 md:grid-cols-2 md:py-24">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wider text-primary">Point of sale for Kenyan businesses</p>
            <h1 className="mt-3 font-display text-4xl font-bold leading-tight md:text-5xl">Sell, get paid on M‑Pesa and know your numbers.</h1>
            <p className="mt-5 text-lg text-slate-300">One app for the till, invoices, stock, suppliers and profit — on your phone, tablet or computer, for one shop or many branches.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/register" className="btn-primary px-6">Start your 14-day free trial</Link>
              <a href="#pricing" className="inline-flex min-h-12 items-center rounded-lg border border-slate-600 px-6 font-semibold hover:bg-white/5">See pricing</a>
            </div>
            <p className="mt-4 text-sm text-slate-400">No card needed. Prices in KES.</p>
          </div>
          <div aria-hidden className="rounded-2xl bg-white p-5 text-ink shadow-2xl">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <span className="font-display font-bold">Till 01 · Shift open</span>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">Online</span>
            </div>
            {[["Sugar 1kg × 2", "400.00"], ["Cooking oil 2L × 1", "650.00"], ["Unga 2kg × 3", "540.00"]].map(([n, v]) => (
              <div key={n} className="flex justify-between border-b border-line py-2 text-sm"><span>{n}</span><span className="num">{v}</span></div>
            ))}
            <div className="flex justify-between py-3 font-display text-xl font-bold"><span>Total</span><span className="num">KES 1,590.00</span></div>
            <div className="rounded-lg bg-primary/10 p-3 text-sm font-medium text-primary-active">M-Pesa payment received ✓</div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16">
        <h2 className="font-display text-3xl font-bold">Answers to the questions every owner asks</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {questions.map(([q, a]) => (
            <div key={q} className="rounded-xl border border-line bg-white p-5">
              <h3 className="font-display font-bold">{q}</h3>
              <p className="mt-2 text-sm text-muted">{a}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="features" className="border-y border-line bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <h2 className="font-display text-3xl font-bold">Everything a Kenyan shop needs to run</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {features.map(([t, d]) => (
              <div key={t}>
                <div className="mb-3 h-1 w-10 rounded bg-primary" />
                <h3 className="font-display text-lg font-bold">{t}</h3>
                <p className="mt-2 text-sm text-muted">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="pricing" className="mx-auto max-w-6xl px-4 py-16">
        <h2 className="font-display text-3xl font-bold">Simple monthly pricing</h2>
        <p className="mt-2 text-muted">Every plan starts with a 14-day free trial. Pay monthly, or yearly in one payment, by M-Pesa. BiasharaPOS never holds your money: M-Pesa payments go straight to your own PayHero account.</p>
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {plans.map((p) => (
            <div key={p.name} className={`flex flex-col rounded-2xl border p-6 ${p.featured ? "border-primary bg-white shadow-lg ring-2 ring-primary/20" : "border-line bg-white"}`}>
              {p.featured && <span className="mb-2 self-start rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-white">Most popular</span>}
              <h3 className="font-display text-xl font-bold">{p.name}</h3>
              <p className="mt-1 text-sm text-muted">{p.who}</p>
              <p className="mt-5 font-display text-3xl font-bold">{p.price ? <>KES <span className="num">{p.price}</span><span className="text-base font-medium text-muted"> / month</span></> : "Custom"}</p>
              {p.price && <p className="text-xs text-muted">monthly or yearly</p>}
              <ul className="mt-5 flex-1 space-y-2 text-sm">
                {p.items.map((i) => <li key={i} className="flex gap-2"><span className="text-primary">✓</span>{i}</li>)}
              </ul>
              <Link to="/register" className={`mt-6 ${p.featured ? "btn-primary" : "inline-flex min-h-12 items-center justify-center rounded-lg border border-line font-semibold hover:border-primary"}`}>{p.cta}</Link>
            </div>
          ))}
        </div>
      </section>

      <section id="faq" className="border-t border-line bg-white">
        <div className="mx-auto max-w-3xl px-4 py-16">
          <h2 className="font-display text-3xl font-bold">Questions</h2>
          <div className="mt-6 divide-y divide-line">
            {faqs.map(([q, a]) => (
              <details key={q} className="group py-4">
                <summary className="cursor-pointer list-none font-semibold marker:hidden">{q}</summary>
                <p className="mt-2 text-sm text-muted">{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-navy text-white">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-4 py-14 md:flex-row md:items-center">
          <div>
            <h2 className="font-display text-3xl font-bold">Set up your business in minutes.</h2>
            <p className="mt-2 text-slate-300">Add products by CSV, invite your cashiers and start selling.</p>
          </div>
          <Link to="/register" className="btn-primary px-6">Start free trial</Link>
        </div>
      </section>

      <footer className="mx-auto flex max-w-6xl flex-wrap justify-between gap-4 px-4 py-8 text-sm text-muted">
        <span>© {new Date().getFullYear()} BiasharaPOS · Made in Kenya</span>
        <Link to="/login" className="hover:text-ink">Sign in</Link>
      </footer>
    </div>
  );
}
