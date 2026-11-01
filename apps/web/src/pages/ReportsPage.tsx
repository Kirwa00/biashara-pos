import { EXPENSE_CATEGORIES, formatKes, toCents } from "@kpos/shared";
import { useState } from "react";
import { api, download } from "../api";
import { Card, Note, formData, useLoad } from "./ui";

type Summary = { from: string; to: string; sales: { count: number; total_cents: string; tax_cents: string }; returns: { count: number; total_cents: string }; gross_profit_cents: string; expenses_cents: string; net_profit_cents: string; payable_cents: string;
  received: { method: string; amount_cents: string }[]; receivable_cents: string; overdue_cents: string; stock_value_cents: string; low_stock: number };

const EXPORTS = ["products", "customers", "suppliers", "documents", "document_lines", "payments", "purchases", "supplier_payments", "expenses", "stock_movements", "shifts"];
type Breakdown = { key: string; label: string; quantity: string; total_cents: string; gross_profit_cents: string };
type Valuation = { as_of: string; total_cents: string; categories: { category: string; value_cents: string }[]; products: { id: string; sku: string; name: string; category: string; on_hand: string; avg_cost_cents: string; value_cents: string }[] };
type Statement = { period: string; sales_cents: string; returns_cents: string; net_sales_cents: string; cogs_cents: string; gross_profit_cents: string; expenses: Record<string, string>; expenses_cents: string; net_profit_cents: string };
type Pnl = { from: string; to: string; months: Statement[]; total: Statement };
type Expense = { id: string; category: string; description: string | null; amount_cents: string; method: string; expense_date: string };

export function ReportsPage() {
  const [msg, setMsg] = useState("");
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: today, to: today });
  const r = useLoad<Summary | null>(`/reports/summary?from=${range.from}&to=${range.to}`, null);
  const s = r.data;
  const [by, setBy] = useState<"product" | "category" | "cashier">("product");
  const breakdown = useLoad<Breakdown[]>(`/reports/breakdown?by=${by}&from=${range.from}&to=${range.to}`, []);
  const [asOf, setAsOf] = useState("");
  const valuation = useLoad<Valuation | null>(`/reports/stock-valuation${asOf ? `?asOf=${asOf}` : ""}`, null);
  const v = valuation.data;
  const pnl = useLoad<Pnl | null>(`/reports/pnl?from=${range.from}&to=${range.to}`, null);
  const pl = pnl.data;
  const plCols = pl ? [...pl.months, pl.total] : [];
  const plRows: [string, (st: Statement) => string, boolean?][] = pl ? [
    ["Sales (net of VAT)", (st) => st.sales_cents], ["Less returns", (st) => st.returns_cents], ["Net sales", (st) => st.net_sales_cents, true],
    ["Cost of goods sold", (st) => st.cogs_cents], ["Gross profit", (st) => st.gross_profit_cents, true],
    ...Object.keys(pl.total.expenses).sort().map((k) => [`Expense: ${k}`, (st: Statement) => st.expenses[k] ?? "0"] as [string, (st: Statement) => string]),
    ["Total expenses", (st) => st.expenses_cents], ["Net profit", (st) => st.net_profit_cents, true],
  ] : [];
  function downloadPnl() {
    const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = [["Line", ...plCols.map((st) => st.period)], ...plRows.map(([label, get]) => [label, ...plCols.map((st) => (Number(get(st)) / 100).toFixed(2))])]
      .map((row) => row.map(cell).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    a.download = `PnL_${range.from}_${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  const expenses = useLoad<Expense[]>(`/expenses?from=${range.from}&to=${range.to}`, []);
  async function addExpense(e: React.FormEvent<HTMLFormElement>) {
    const form = e.currentTarget;
    const f = formData(e);
    try {
      await api("/expenses", { method: "POST", body: JSON.stringify({ category: f.category, description: f.description || undefined, amountCents: toCents(f.amount ?? "0"), method: f.method, expenseDate: f.expenseDate || undefined }) });
      form.reset();
      expenses.reload();
      r.reload();
      pnl.reload();
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
        <Card title="Sales breakdown (net of returns)">
          <div className="mb-3 flex gap-2">
            {(["product", "category", "cashier"] as const).map((b) => (
              <button key={b} onClick={() => setBy(b)} className={`rounded-lg border border-line px-3 py-1 text-sm capitalize ${by === b ? "bg-surface font-semibold" : ""}`}>{b}</button>
            ))}
          </div>
          <Note msg={breakdown.msg} />
          {breakdown.data.length ? (
            <table className="w-full text-left text-sm">
              <thead className="text-muted"><tr><th className="py-1 capitalize">{by}</th><th className="text-right">{by === "product" ? "Qty" : ""}</th><th className="text-right">Sales</th><th className="text-right">Gross profit</th></tr></thead>
              <tbody>{breakdown.data.map((row) => (
                <tr key={row.key} className="border-t border-line"><td className="py-2">{row.label}</td><td className="num text-right">{by === "product" ? Number(row.quantity) : ""}</td><td className="num text-right">{formatKes(Number(row.total_cents))}</td><td className="num text-right">{formatKes(Number(row.gross_profit_cents))}</td></tr>
              ))}</tbody>
            </table>
          ) : <p className="text-sm text-muted">No sales in this period.</p>}
        </Card>
      </>)}
      <Card title="Profit & loss (net of VAT)">
        <Note msg={pnl.msg} />
        {pl && (pl.months.length ? (<>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-muted"><tr><th className="py-1">Line</th>{plCols.map((st) => <th key={st.period} className="text-right">{st.period === "TOTAL" ? "Total" : st.period}</th>)}</tr></thead>
              <tbody>{plRows.map(([label, get, bold]) => (
                <tr key={label} className={`border-t border-line ${bold ? "font-semibold" : ""}`}><td className="py-2">{label}</td>{plCols.map((st) => <td key={st.period} className="num text-right">{formatKes(Number(get(st)))}</td>)}</tr>
              ))}</tbody>
            </table>
          </div>
          <button className="btn-primary mt-3" onClick={downloadPnl}>Download CSV</button>
        </>) : <p className="text-sm text-muted">No sales or expenses in this period.</p>)}
      </Card>
      <Card title="Stock valuation (at average cost)">
        <div className="mb-3 flex items-center gap-2 text-sm">
          <span className="text-muted">As at</span>
          <input type="date" value={asOf} max={today} onChange={(e) => setAsOf(e.target.value)} className="input max-w-44" />
          {asOf && <button className="text-primary hover:underline" onClick={() => setAsOf("")}>Now</button>}
        </div>
        <Note msg={valuation.msg} />
        {v && (<>
          <p className="num mb-3 font-display text-2xl font-bold">{formatKes(Number(v.total_cents))}</p>
          <div className="mb-4 flex flex-wrap gap-2">
            {v.categories.map((c) => <span key={c.category} className="rounded-lg bg-surface px-3 py-1 text-sm">{c.category}: <span className="num font-semibold">{formatKes(Number(c.value_cents))}</span></span>)}
          </div>
          {v.products.length ? (
            <table className="w-full text-left text-sm">
              <thead className="text-muted"><tr><th className="py-1">Product</th><th>Category</th><th className="text-right">On hand</th><th className="text-right">Avg cost</th><th className="text-right">Value</th></tr></thead>
              <tbody>{v.products.map((p) => (
                <tr key={p.id} className="border-t border-line"><td className="py-2">{p.name} <span className="text-xs text-muted">{p.sku}</span></td><td>{p.category}</td><td className="num text-right">{Number(p.on_hand)}</td><td className="num text-right">{formatKes(Number(p.avg_cost_cents))}</td><td className="num text-right">{formatKes(Number(p.value_cents))}</td></tr>
              ))}</tbody>
            </table>
          ) : <p className="text-sm text-muted">No stock on hand.</p>}
        </>)}
      </Card>
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
