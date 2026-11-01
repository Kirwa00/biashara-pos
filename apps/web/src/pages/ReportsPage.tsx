import { EXPENSE_CATEGORIES, formatKes, toCents } from "@kpos/shared";
import { useState } from "react";
import { api, download } from "../api";
import { Card, Note, formData, useLoad } from "./ui";

type Summary = { from: string; to: string; sales: { count: number; total_cents: string; tax_cents: string }; returns: { count: number; total_cents: string }; gross_profit_cents: string; expenses_cents: string; net_profit_cents: string; payable_cents: string;
  received: { method: string; amount_cents: string }[]; receivable_cents: string; overdue_cents: string; stock_value_cents: string; low_stock: number };

const EXPORTS = ["products", "customers", "suppliers", "documents", "document_lines", "payments", "purchases", "supplier_payments", "expenses", "stock_movements", "shifts"];
type Expense = { id: string; category: string; description: string | null; amount_cents: string; method: string; expense_date: string };

export function ReportsPage() {
  const [msg, setMsg] = useState("");
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: today, to: today });
  const r = useLoad<Summary | null>(`/reports/summary?from=${range.from}&to=${range.to}`, null);
  const s = r.data;
  const expenses = useLoad<Expense[]>(`/expenses?from=${range.from}&to=${range.to}`, []);
  async function addExpense(e: React.FormEvent<HTMLFormElement>) {
    const form = e.currentTarget;
    const f = formData(e);
    try {
      await api("/expenses", { method: "POST", body: JSON.stringify({ category: f.category, description: f.description || undefined, amountCents: toCents(f.amount ?? "0"), method: f.method, expenseDate: f.expenseDate || undefined }) });
      form.reset();
      expenses.reload();
      r.reload();
    } catch (err) {
      expenses.setMsg((err as Error).message);
    }
  }
  const tile = (label: string, value: string) => <div className="rounded-xl border border-line bg-card p-4"><p className="text-sm text-muted">{label}</p><p className="num mt-1 font-display text-2xl font-bold">{value}</p></div>;
  return (
    <div className="space-y-6">
      <div className="flex gap-3">
        <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} className="input max-w-44" />
        <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} className="input max-w-44" />
      </div>
      <Note msg={r.msg} />
      {s && (<>
        <div className="grid gap-4 md:grid-cols-4">
          {tile(`Sales (${s.sales.count})`, formatKes(Number(s.sales.total_cents)))}
          {tile(`Returns (${s.returns.count})`, formatKes(Number(s.returns.total_cents)))}
          {tile("Gross profit", formatKes(Number(s.gross_profit_cents)))}
          {tile("Expenses", formatKes(Number(s.expenses_cents)))}
          {tile("Net profit", formatKes(Number(s.net_profit_cents)))}
          {tile("Owed to you", formatKes(Number(s.receivable_cents)))}
          {tile("You owe suppliers", formatKes(Number(s.payable_cents)))}
          {tile("Overdue", formatKes(Number(s.overdue_cents)))}
          {tile("VAT on sales", formatKes(Number(s.sales.tax_cents)))}
          {tile("Stock value", formatKes(Number(s.stock_value_cents)))}
          {tile("Low-stock items", String(s.low_stock))}
        </div>
        <Card title="Cash received">
          {s.received.length ? s.received.map((m) => <div key={m.method} className="flex justify-between border-t border-line py-2"><span>{m.method}</span><span className="num">{formatKes(Number(m.amount_cents))}</span></div>) : <p className="text-muted">No payments in this period.</p>}
        </Card>
      </>)}
      <Card title="Operating expenses">
        <Note msg={expenses.msg} />
        <form onSubmit={addExpense} className="mb-4 grid gap-2 md:grid-cols-6">
          <select name="category" className="input">{EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
          <input name="description" placeholder="Description" className="input md:col-span-2" />
          <input name="amount" required inputMode="decimal" placeholder="Amount (KES)" className="input" />
          <select name="method" className="input">{["CASH", "MPESA", "BANK", "CARD"].map((m) => <option key={m}>{m}</option>)}</select>
          <input name="expenseDate" type="date" defaultValue={today} className="input" />
          <button className="btn-primary md:col-span-6">Add expense</button>
        </form>
        {expenses.data.length ? expenses.data.map((x) => (
          <div key={x.id} className="flex justify-between gap-3 border-t border-line py-2 text-sm"><span>{x.expense_date.slice(0, 10)} · {x.category}{x.description ? ` · ${x.description}` : ""}</span><span className="num">{formatKes(Number(x.amount_cents))}</span></div>
        )) : <p className="text-sm text-muted">No expenses in this period.</p>}
      </Card>
      <Card title="Export your data (owner)">
        <p className="mb-3 text-sm text-muted">CSV files you can open in Excel or keep as an offline copy.</p>
        <div className="flex flex-wrap gap-2">
          {EXPORTS.map((e) => <button key={e} className="rounded-lg border border-line px-3 py-1 text-sm" onClick={() => download(`/export/${e}`, `${e}-${today}.csv`).catch((err) => setMsg((err as Error).message))}>{e.replace("_", " ")}</button>)}
        </div>
        <Note msg={msg} />
      </Card>
    </div>
  );
}
