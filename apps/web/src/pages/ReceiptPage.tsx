import { formatKes } from "@kpos/shared";
import { useParams } from "react-router";
import { useLoad } from "./ui";

type Line = { id: string; description: string; quantity: string; unit_price_cents: string; total_cents: string; tax_code: string };
type Doc = { type: string; number: number; issue_date: string; customer_name: string | null; customer_kra_pin: string | null; net_cents: string; tax_cents: string;
  total_cents: string; paid_cents: string; lines: Line[]; payments: { id: string; method: string; amount_cents: string; reference: string | null; status: string }[] };
const TITLE: Record<string, [string, string]> = { SALE: ["Receipt", "RCT"], INVOICE: ["Tax invoice", "INV"], QUOTE: ["Quotation", "QT"], CREDIT_NOTE: ["Credit note", "CN"] };

export function ReceiptPage() {
  const { id } = useParams();
  const doc = useLoad<Doc | null>(`/documents/${id}`, null);
  const me = useLoad<{ business?: { name: string; kra_pin?: string | null } } | null>("/me", null);
  const d = doc.data;
  if (!d) return <p className="p-6">{doc.msg || "Loading…"}</p>;
  const [title, prefix] = TITLE[d.type] ?? ["Document", "DOC"];
  const kes = (v: string) => formatKes(Number(v));
  return (
    <div className="mx-auto max-w-sm p-4 font-mono text-sm">
      <div className="text-center">
        <p className="text-base font-bold">{me.data?.business?.name ?? ""}</p>
        {me.data?.business?.kra_pin && <p>PIN {me.data.business.kra_pin}</p>}
        <p className="mt-2 font-bold">{title} {prefix}-{String(d.number).padStart(4, "0")}</p>
        <p>{d.issue_date.slice(0, 10)}</p>
        {d.customer_name && <p>{d.customer_name}{d.customer_kra_pin ? ` · ${d.customer_kra_pin}` : ""}</p>}
      </div>
      <hr className="my-2 border-dashed" />
      {d.lines.map((l) => (
        <div key={l.id}><p>{l.description}</p><p className="flex justify-between"><span>{Number(l.quantity)} × {kes(l.unit_price_cents)} [{l.tax_code}]</span><span>{kes(l.total_cents)}</span></p></div>
      ))}
      <hr className="my-2 border-dashed" />
      <p className="flex justify-between"><span>Net</span><span>{kes(d.net_cents)}</span></p>
      <p className="flex justify-between"><span>VAT</span><span>{kes(d.tax_cents)}</span></p>
      <p className="flex justify-between font-bold"><span>Total</span><span>{kes(d.total_cents)}</span></p>
      {d.payments.filter((p) => p.status === "CONFIRMED").map((p) => (
        <p key={p.id} className="flex justify-between"><span>{p.method}{p.reference ? ` ${p.reference}` : ""}</span><span>{kes(p.amount_cents)}</span></p>
      ))}
      <p className="mt-4 text-center">Asante! Karibu tena.</p>
      <button onClick={() => window.print()} className="btn-primary mt-4 w-full print:hidden">Print</button>
    </div>
  );
}
