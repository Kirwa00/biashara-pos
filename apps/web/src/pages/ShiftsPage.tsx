import { formatKes, toCents } from "@kpos/shared";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { Card, Note, useLoad } from "./ui";

type MethodTaking = { method: string; amount_cents: string; count: number };

type Shift = {
  id: string;
  user_id: string;
  user_name?: string;
  opened_at: string;
  closed_at: string | null;
  status: "OPEN" | "CLOSED";
  opening_float_cents: string;
  expected_cash_cents: number;
  counted_cash_cents: string | null;
  variance_cents: number | null;
  note: string | null;
  by_method?: MethodTaking[];
};

export function ShiftsPage() {
  const currentShift = useLoad<Shift | null>("/shifts/current", null);
  const shiftList = useLoad<Shift[]>("/shifts", []);
  
  const [openFloat, setOpenFloat] = useState("0");
  const [countedCash, setCountedCash] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [msg, setMsg] = useState("");

  const active = currentShift.data;
  const expectedCents = active ? active.expected_cash_cents : 0;
  const countedCents = countedCash ? toCents(countedCash) : null;
  const liveVarianceCents = countedCents !== null ? countedCents - expectedCents : null;

  async function handleOpenShift(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/shifts/open", {
        method: "POST",
        body: JSON.stringify({ openingFloatCents: toCents(openFloat || "0") }),
      });
      setMsg("Shift opened successfully.");
      currentShift.reload();
      shiftList.reload();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  async function handleCloseShift(e: React.FormEvent) {
    e.preventDefault();
    if (!active) return;
    if (!countedCash) {
      setMsg("Please enter counted cash in drawer.");
      return;
    }
    try {
      const res = await api<{ expected_cash_cents: number; variance_cents: number }>(
        `/shifts/${active.id}/close`,
        {
          method: "POST",
          body: JSON.stringify({
            countedCashCents: toCents(countedCash),
            note: closeNote || undefined,
          }),
        }
      );
      setMsg(
        `Shift closed (Z-Report generated). Expected: ${formatKes(res.expected_cash_cents)}, Variance: ${formatKes(res.variance_cents)}`
      );
      setCountedCash("");
      setCloseNote("");
      currentShift.reload();
      shiftList.reload();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold">Till Shifts & Cash-Up</h1>
          <p className="text-sm text-muted">Daily drawer float control, cash-up variance, and Z-report reading</p>
        </div>
        {active && (
          <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-4 py-1.5 text-sm font-semibold text-primary">
            <span className="h-2.5 w-2.5 rounded-full bg-primary animate-pulse" />
            Active Shift Since {new Date(active.opened_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>
        )}
      </div>

      <Note msg={msg || currentShift.msg || shiftList.msg} />

      {active ? (
        <div className="grid gap-6 xl:grid-cols-3">
          {/* Active Shift Card */}
          <Card title="Current Till Session (X-Reading)" className="xl:col-span-2">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
              <div className="rounded-lg bg-surface p-3">
                <span className="text-xs uppercase text-muted font-medium">Opening Float</span>
                <p className="num mt-1 font-display text-xl font-bold">{formatKes(Number(active.opening_float_cents))}</p>
              </div>
              <div className="rounded-lg bg-surface p-3">
                <span className="text-xs uppercase text-muted font-medium">Drawer Cash Expected</span>
                <p className="num mt-1 font-display text-xl font-bold text-primary">{formatKes(active.expected_cash_cents)}</p>
              </div>
              <div className="rounded-lg bg-surface p-3">
                <span className="text-xs uppercase text-muted font-medium">Opened At</span>
                <p className="mt-1 text-sm font-semibold">{new Date(active.opened_at).toLocaleTimeString()}</p>
              </div>
              <div className="rounded-lg bg-surface p-3">
                <span className="text-xs uppercase text-muted font-medium">Status</span>
                <p className="mt-1 text-sm font-bold text-primary">OPEN</p>
              </div>
            </div>

            <h3 className="mb-2 text-sm font-semibold uppercase text-muted">Takings by Tender</h3>
            <div className="divide-y divide-line border-y border-line mb-6">
              {active.by_method && active.by_method.length > 0 ? (
                active.by_method.map((m) => (
                  <div key={m.method} className="flex justify-between py-2 text-sm">
                    <span className="font-medium">{m.method} ({m.count} payments)</span>
                    <span className="num font-semibold">{formatKes(Number(m.amount_cents))}</span>
                  </div>
                ))
              ) : (
                <p className="py-3 text-sm text-muted">No completed payments recorded in this shift yet.</p>
              )}
            </div>

            <div className="flex gap-3">
              <Link to="/till" className="btn-primary">
                Return to POS Till
              </Link>
            </div>
          </Card>

          {/* Close Shift Cash-Up Form */}
          <Card title="Close Shift & Cash-Up (Z-Report)">
            <form onSubmit={handleCloseShift} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase text-muted">
                  Actual Counted Cash in Drawer (KES)
                </label>
                <input
                  type="number"
                  step="0.01"
                  required
                  placeholder="e.g. 15000"
                  value={countedCash}
                  onChange={(e) => setCountedCash(e.target.value)}
                  className="input font-display text-lg"
                />
              </div>

              {liveVarianceCents !== null && (
                <div
                  className={`rounded-lg p-3 text-sm font-medium ${
                    liveVarianceCents === 0
                      ? "bg-primary/10 text-primary"
                      : liveVarianceCents > 0
                      ? "bg-amber-50 text-warning"
                      : "bg-red-50 text-critical"
                  }`}
                >
                  <div className="flex justify-between">
                    <span>Cash Variance:</span>
                    <span className="num font-bold">
                      {liveVarianceCents > 0 ? `+${formatKes(liveVarianceCents)} (Surplus)` : liveVarianceCents < 0 ? `${formatKes(liveVarianceCents)} (Deficit)` : "Balanced (KES 0.00)"}
                    </span>
                  </div>
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase text-muted">
                  Supervisor / Cashier Notes (Optional)
                </label>
                <textarea
                  rows={2}
                  value={closeNote}
                  onChange={(e) => setCloseNote(e.target.value)}
                  placeholder="Reason for any cash variance..."
                  className="w-full rounded-lg border border-line p-2 text-sm outline-none focus:border-primary"
                />
              </div>

              <button type="submit" className="w-full rounded-lg bg-navy py-3 font-semibold text-white hover:bg-slate-800 transition">
                Submit Cash-Up & Close Shift (Z)
              </button>
            </form>
          </Card>
        </div>
      ) : (
        <Card title="Start New Shift">
          <div className="max-w-md space-y-4">
            <p className="text-sm text-muted">
              There is currently no open shift on this terminal. Enter the opening float from the safe to begin taking sales.
            </p>
            <form onSubmit={handleOpenShift} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase text-muted">
                  Opening Drawer Float (KES)
                </label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={openFloat}
                  onChange={(e) => setOpenFloat(e.target.value)}
                  placeholder="0.00"
                  className="input font-display text-lg"
                />
              </div>
              <button type="submit" className="btn-primary w-full">
                Open Till Shift
              </button>
            </form>
          </div>
        </Card>
      )}

      {/* Historical Shifts Table */}
      <Card title="Recent Shift History & Cash Audits">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="py-2.5">Shift ID</th>
                <th>Cashier</th>
                <th>Opened</th>
                <th>Closed</th>
                <th className="text-right">Float</th>
                <th className="text-right">Expected</th>
                <th className="text-right">Counted</th>
                <th className="text-right">Variance</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {shiftList.data.map((s) => (
                <tr key={s.id} className="hover:bg-surface/50">
                  <td className="py-3 font-mono text-xs">{s.id.slice(0, 8)}</td>
                  <td>{s.user_name ?? "Cashier"}</td>
                  <td>{new Date(s.opened_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</td>
                  <td>{s.closed_at ? new Date(s.closed_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—"}</td>
                  <td className="num text-right">{formatKes(Number(s.opening_float_cents))}</td>
                  <td className="num text-right">{formatKes(s.expected_cash_cents)}</td>
                  <td className="num text-right">{s.counted_cash_cents ? formatKes(Number(s.counted_cash_cents)) : "—"}</td>
                  <td className={`num text-right font-medium ${
                    s.variance_cents == null
                      ? ""
                      : s.variance_cents === 0
                      ? "text-primary"
                      : s.variance_cents < 0
                      ? "text-critical"
                      : "text-warning"
                  }`}>
                    {s.variance_cents != null ? formatKes(s.variance_cents) : "—"}
                  </td>
                  <td>
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
                        s.status === "OPEN" ? "bg-primary/10 text-primary" : "bg-slate-100 text-slate-700"
                      }`}
                    >
                      {s.status}
                    </span>
                  </td>
                </tr>
              ))}
              {shiftList.data.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-6 text-center text-muted">
                    No shift records found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
