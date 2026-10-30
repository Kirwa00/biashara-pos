import { formatKes } from "@kpos/shared";
import { useParams } from "react-router";
import { useLoad } from "./ui";

type MethodTaking = { method: string; amount_cents: string; count: number };

type Shift = {
  id: string;
  user_id: string;
  opened_at: string;
  closed_at: string | null;
  status: "OPEN" | "CLOSED";
  opening_float_cents: string;
  expected_cash_cents: number;
  counted_cash_cents: string | null;
  variance_cents: number | null;
  note: string | null;
  by_method: MethodTaking[];
};

export function ZReportPage() {
  const { id } = useParams();
  const shift = useLoad<Shift | null>(`/shifts/${id}`, null);
  const me = useLoad<{ business?: { name: string; kra_pin?: string | null }; user?: { name: string } } | null>("/me", null);

  const s = shift.data;
  if (!s) return <p className="p-6 font-mono text-sm">{shift.msg || "Loading Z-Report…"}</p>;

  return (
    <div className="mx-auto max-w-sm p-4 font-mono text-sm">
      <div className="text-center">
        <p className="text-base font-bold uppercase">{me.data?.business?.name ?? "BiasharaPOS"}</p>
        {me.data?.business?.kra_pin && <p className="text-xs">KRA PIN: {me.data.business.kra_pin}</p>}
        <p className="mt-2 font-bold text-base">*** TILL Z-REPORT ***</p>
        <p className="text-xs">Shift #{s.id.slice(0, 8).toUpperCase()}</p>
        <p className="text-xs">Cashier: {me.data?.user?.name ?? "Cashier"}</p>
      </div>

      <hr className="my-2 border-dashed" />

      <div className="text-xs space-y-1">
        <p className="flex justify-between">
          <span>Opened:</span>
          <span>{new Date(s.opened_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</span>
        </p>
        <p className="flex justify-between">
          <span>Closed:</span>
          <span>{s.closed_at ? new Date(s.closed_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "ACTIVE"}</span>
        </p>
      </div>

      <hr className="my-2 border-dashed" />

      <div className="space-y-1 text-xs">
        <p className="flex justify-between">
          <span>Opening Float:</span>
          <span className="font-semibold">{formatKes(Number(s.opening_float_cents))}</span>
        </p>
      </div>

      <p className="mt-2 text-xs font-bold uppercase">Confirmed Takings</p>
      <div className="divide-y divide-dotted border-y border-dotted my-1 text-xs">
        {s.by_method.map((m) => (
          <p key={m.method} className="flex justify-between py-1">
            <span>{m.method} ({m.count} txns):</span>
            <span className="font-semibold">{formatKes(Number(m.amount_cents))}</span>
          </p>
        ))}
        {s.by_method.length === 0 && (
          <p className="py-1 text-muted">No sales completed.</p>
        )}
      </div>

      <div className="mt-2 space-y-1 text-xs">
        <p className="flex justify-between">
          <span>Expected Cash in Drawer:</span>
          <span className="font-bold">{formatKes(s.expected_cash_cents)}</span>
        </p>
        <p className="flex justify-between">
          <span>Actual Counted Cash:</span>
          <span className="font-bold">{s.counted_cash_cents ? formatKes(Number(s.counted_cash_cents)) : "—"}</span>
        </p>
        <p className="flex justify-between font-bold text-sm">
          <span>Cash Variance:</span>
          <span className={s.variance_cents && s.variance_cents < 0 ? "text-red-600" : ""}>
            {s.variance_cents != null ? formatKes(s.variance_cents) : "—"}
          </span>
        </p>
      </div>

      {s.note && (
        <div className="mt-3 text-xs bg-slate-50 p-2 rounded">
          <p className="font-semibold">Note:</p>
          <p>{s.note}</p>
        </div>
      )}

      <div className="mt-8 pt-4 border-t border-dashed text-center text-xs space-y-4">
        <div>
          <p className="border-b border-black w-48 mx-auto mb-1"></p>
          <p>Cashier Signature</p>
        </div>
        <div>
          <p className="border-b border-black w-48 mx-auto mb-1"></p>
          <p>Manager Verification</p>
        </div>
        <p className="text-[10px] text-muted">End of Fiscal Shift Report</p>
      </div>

      <button onClick={() => window.print()} className="btn-primary mt-6 w-full print:hidden">
        Print Z-Report
      </button>
    </div>
  );
}
