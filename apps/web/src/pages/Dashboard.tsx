import { formatKes } from "@kpos/shared";
import { Link } from "react-router";
import { Card, useLoad } from "./ui";

type Summary = { sales: { count: number; total_cents: string }; gross_profit_cents: string; received: { method: string; amount_cents: string }[];
  receivable_cents: string; overdue_cents: string; low_stock: number };
type Alerts = { low_stock: { id: string; sku: string; name: string; on_hand: string; reorder_level: string }[];
  overdue: { id: string; number: number; due_date: string; balance_cents: string; customer_name: string | null; customer_phone: string | null }[];
  pending_adjustments: number; open_shifts: number };

export function Dashboard() {
  const s = useLoad<Summary | null>("/reports/summary", null).data;
  const a = useLoad<Alerts | null>("/reports/alerts", null);
  const kes = (v?: string | number) => (v === undefined ? "—" : formatKes(Number(v)));
  const received = s?.received.filter((m) => m.method === "CASH" || m.method === "MPESA").reduce((t, m) => t + Number(m.amount_cents), 0);
  const tiles = [
    { hint: "Sales today", label: "What have I sold?", value: kes(s?.sales.total_cents), to: "/sales" },
    { hint: "Debtors", label: "Who owes me money?", value: kes(s?.receivable_cents), to: "/sales" },
    { hint: "Cash & M-Pesa today", label: "How much cash have I received?", value: kes(received), to: "/reports" },
    { hint: "Low stock", label: "What stock needs replenishing?", value: s ? String(s.low_stock) : "—", to: "/inventory" },
    { hint: "Gross profit today", label: "Am I making a profit?", value: kes(s?.gross_profit_cents), to: "/reports" },
  ];
  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl font-bold">Overview</h1>
      {a.msg && <p className="text-sm text-muted">{a.msg}</p>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {tiles.map((q) => (
          <Link key={q.label} to={q.to} className="rounded-xl border border-line bg-card p-5 hover:bg-surface">
            <p className="text-xs uppercase tracking-wide text-muted">{q.hint}</p>
            <p className="num mt-2 font-display text-2xl font-bold">{q.value}</p>
            <p className="mt-2 text-sm text-muted">{q.label}</p>
          </Link>
        ))}
      </div>
      {a.data && (
        <div className="grid gap-6 xl:grid-cols-2">
          <Card title={`Reorder now (${a.data.low_stock.length})`}>
            {a.data.low_stock.length ? a.data.low_stock.map((p) => (
              <div key={p.id} className="flex justify-between border-t border-line py-2 text-sm"><span>{p.sku} — {p.name}</span><span className="num">{Number(p.on_hand)} / {Number(p.reorder_level)}</span></div>
            )) : <p className="text-sm text-muted">Nothing below its reorder level.</p>}
          </Card>
          <Card title={`Overdue invoices (${a.data.overdue.length})`}>
            {a.data.overdue.length ? a.data.overdue.map((d) => (
              <div key={d.id} className="flex justify-between gap-3 border-t border-line py-2 text-sm">
                <span>INV-{String(d.number).padStart(4, "0")} · {d.customer_name ?? "—"}{d.customer_phone ? ` · ${d.customer_phone}` : ""} · due {d.due_date.slice(0, 10)}</span>
                <span className="num">{kes(d.balance_cents)}</span>
              </div>
            )) : <p className="text-sm text-muted">No overdue invoices.</p>}
          </Card>
          {(a.data.pending_adjustments > 0 || a.data.open_shifts > 0) && (
            <p className="text-sm text-muted xl:col-span-2">
              {a.data.pending_adjustments > 0 && <Link to="/inventory" className="text-primary">{a.data.pending_adjustments} stock adjustment(s) awaiting approval. </Link>}
              {a.data.open_shifts > 0 && <span>{a.data.open_shifts} till shift(s) open.</span>}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
