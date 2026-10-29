const QUESTIONS = [
  { label: "What have I sold?", hint: "Sales today" },
  { label: "Who owes me money?", hint: "Debtors" },
  { label: "How much cash have I received?", hint: "Cash & M-Pesa" },
  { label: "What stock needs replenishing?", hint: "Low stock" },
  { label: "Am I making a profit?", hint: "Gross profit" },
];

export function Dashboard() {
  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl font-bold">Overview</h1>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {QUESTIONS.map((q) => (
          <div key={q.label} className="rounded-xl border border-line bg-card p-5">
            <p className="text-xs uppercase tracking-wide text-muted">{q.hint}</p>
            <p className="num mt-2 font-display text-2xl font-bold">—</p>
            <p className="mt-2 text-sm text-muted">{q.label}</p>
          </div>
        ))}
      </div>
      <p className="text-sm text-muted">Figures appear once sales, invoices and stock are recorded (Sprints 1–5).</p>
    </div>
  );
}
