import { formatKes } from "@kpos/shared";
import { useParams } from "react-router";
import { useLoad } from "./ui";

type Line = { id: string; description: string; quantity: string; unit_price_cents: string; tax_code: string; net_cents: string; tax_cents: string; total_cents: string };
type Doc = {
  type: "QUOTE" | "INVOICE" | "SALE" | "CREDIT_NOTE";
  number: number;
  status: string;
  issue_date: string;
  due_date: string | null;
  customer_name: string | null;
  customer_kra_pin: string | null;
  customer_phone: string | null;
  source_type: string | null;
  source_number: number | null;
  net_cents: string;
  tax_cents: string;
  total_cents: string;
  paid_cents: string;
  lines: Line[];
};
type Me = { business?: { name: string; kra_pin: string | null; phone: string | null } };

const META: Record<Doc["type"], [string, string]> = {
  QUOTE: ["Quotation", "QT"],
  INVOICE: ["Tax Invoice", "INV"],
  SALE: ["Sales Receipt", "RCT"],
  CREDIT_NOTE: ["Credit Note", "CN"],
};
const ref = (type: string, n: number) => `${META[type as Doc["type"]]?.[1] ?? "DOC"}-${String(n).padStart(4, "0")}`;

/** A4 layout for invoices, quotations and credit notes; "Save as PDF" from the browser print dialog. */
export function DocumentPrintPage() {
  const { id } = useParams();
  const doc = useLoad<Doc | null>(`/documents/${id}`, null);
  const me = useLoad<Me | null>("/me", null);
  const d = doc.data;
  if (!d) return <p className="p-6">{doc.msg || "Loading…"}</p>;
  const b = me.data?.business;
  const kes = (v: string | number) => formatKes(Number(v));
  const balance = Number(d.total_cents) - Number(d.paid_cents);
  const vatByCode = Object.entries(
    d.lines.reduce<Record<string, [number, number]>>((acc, l) => {
      const [n, t] = acc[l.tax_code] ?? [0, 0];
      acc[l.tax_code] = [n + Number(l.net_cents), t + Number(l.tax_cents)];
      return acc;
    }, {}),
  );

  return (
    <div className="mx-auto max-w-[210mm] bg-white p-4 text-sm text-ink sm:p-8 print:p-0">
      <style>{"@page { size: A4; margin: 14mm; }"}</style>
      <div className="mb-6 flex justify-end gap-2 print:hidden">
        <button onClick={() => window.print()} className="btn-primary">Print / Save as PDF</button>
      </div>

      <header className="flex items-start justify-between border-b-2 border-ink pb-4">
        <div>
          <p className="font-display text-2xl font-bold">{b?.name ?? ""}</p>
          {b?.kra_pin && <p>KRA PIN: {b.kra_pin}</p>}
          {b?.phone && <p>Tel: {b.phone}</p>}
        </div>
        <div className="text-right">
          <p className="font-display text-2xl font-bold uppercase">{META[d.type][0]}</p>
          <p className="font-mono text-base">{ref(d.type, d.number)}</p>
          {d.type === "CREDIT_NOTE" && d.source_type && d.source_number != null && <p>Against {ref(d.source_type, d.source_number)}</p>}
        </div>
      </header>

      <section className="mt-4 grid grid-cols-2 gap-6">
        <div>
          <p className="text-xs font-semibold uppercase text-muted">{d.type === "QUOTE" ? "Prepared for" : "Bill to"}</p>
          <p className="font-semibold">{d.customer_name ?? "Walk-in customer"}</p>
          {d.customer_kra_pin && <p>KRA PIN: {d.customer_kra_pin}</p>}
          {d.customer_phone && <p>Tel: {d.customer_phone}</p>}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 text-right">
          <dt className="text-muted">Date</dt>
          <dd>{d.issue_date.slice(0, 10)}</dd>
          {d.due_date && d.type === "INVOICE" && (
            <>
              <dt className="text-muted">Due date</dt>
              <dd>{d.due_date.slice(0, 10)}</dd>
            </>
          )}
          <dt className="text-muted">Status</dt>
          <dd>{d.status}</dd>
        </dl>
      </section>

      <div className="overflow-x-auto print:overflow-visible"><table className="mt-6 w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-ink text-xs uppercase">
            <th className="py-2">#</th>
            <th>Description</th>
            <th className="text-right">Qty</th>
            <th className="text-right">Unit price</th>
            <th className="text-center">VAT</th>
            <th className="text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l, i) => (
            <tr key={l.id} className="border-b border-line">
              <td className="py-2">{i + 1}</td>
              <td>{l.description}</td>
              <td className="num text-right">{Number(l.quantity)}</td>
              <td className="num text-right">{kes(l.unit_price_cents)}</td>
              <td className="text-center">{l.tax_code}</td>
              <td className="num text-right">{kes(l.total_cents)}</td>
            </tr>
          ))}
        </tbody>
      </table></div>

      <section className="mt-4 flex justify-between gap-6">
        <div className="overflow-x-auto print:overflow-visible"><table className="text-xs">
          <thead>
            <tr className="text-muted">
              <th className="pr-4 text-left">VAT code</th>
              <th className="pr-4 text-right">Net</th>
              <th className="text-right">VAT</th>
            </tr>
          </thead>
          <tbody>
            {vatByCode.map(([code, [n, t]]) => (
              <tr key={code}>
                <td className="pr-4">{code}</td>
                <td className="num pr-4 text-right">{kes(n)}</td>
                <td className="num text-right">{kes(t)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <dl className="grid w-64 grid-cols-2 gap-y-1 text-right">
          <dt>Net</dt>
          <dd className="num">{kes(d.net_cents)}</dd>
          <dt>VAT</dt>
          <dd className="num">{kes(d.tax_cents)}</dd>
          <dt className="border-t border-ink pt-1 font-bold">Total</dt>
          <dd className="num border-t border-ink pt-1 font-bold">{kes(d.total_cents)}</dd>
          {d.type === "INVOICE" && (
            <>
              <dt>Paid</dt>
              <dd className="num">{kes(d.paid_cents)}</dd>
              <dt className="font-bold">Balance due</dt>
              <dd className="num font-bold">{kes(balance)}</dd>
            </>
          )}
        </dl>
      </section>

      <footer className="mt-10 border-t border-line pt-3 text-xs text-muted">
        {d.type === "QUOTE" ? "This quotation is not a tax invoice. Prices may change." : "Not yet submitted to KRA eTIMS."}
      </footer>
    </div>
  );
}
