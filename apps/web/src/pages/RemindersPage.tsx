import { formatKes } from "@kpos/shared";
import { useState } from "react";
import { api } from "../api";
import { Card, Note, useLoad } from "./ui";

type Debtor = {
  id: string;
  name: string;
  phone: string | null;
  invoices: number;
  overdue_cents: string;
  oldest_due: string;
  days_overdue: number;
  last_reminded_at: string | null;
  reminders: number;
};

const intl = (phone: string) => phone.replace(/^\+/, "").replace(/^0/, "254");

/** Overdue customers with one-tap WhatsApp/SMS reminders sent from the user's own phone; each tap is logged. */
export function RemindersPage() {
  const debtors = useLoad<Debtor[]>("/reminders/overdue", []);
  const me = useLoad<{ business?: { name: string } } | null>("/me", null);
  const [msg, setMsg] = useState("");
  const business = me.data?.business?.name ?? "us";

  const text = (d: Debtor) =>
    `Hello ${d.name}, this is a friendly reminder from ${business} that ${formatKes(Number(d.overdue_cents))} ` +
    `on ${d.invoices} invoice${d.invoices === 1 ? "" : "s"} is overdue (oldest due ${d.oldest_due.slice(0, 10)}). Kindly pay at your earliest convenience. Thank you.`;

  const log = async (d: Debtor, channel: "WHATSAPP" | "SMS" | "CALL") => {
    try {
      await api(`/customers/${d.id}/reminders`, { method: "POST", body: JSON.stringify({ channel }) });
      setMsg(`Reminder to ${d.name} logged.`);
      debtors.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const total = debtors.data.reduce((s, d) => s + Number(d.overdue_cents), 0);
  const link = "rounded px-2 py-1 text-xs font-bold";

  return (
    <div className="space-y-4">
      <Note msg={msg || debtors.msg} />
      <Card title={`Overdue customers · ${formatKes(total)}`}>
        <p className="mb-3 text-xs text-muted">Reminders open WhatsApp or SMS on this device with the message filled in; you press send.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-muted">
                <th className="py-2">Customer</th>
                <th className="text-right">Overdue</th>
                <th className="text-right">Invoices</th>
                <th className="text-right">Days late</th>
                <th>Last reminded</th>
                <th className="text-right">Remind</th>
              </tr>
            </thead>
            <tbody>
              {debtors.data.map((d) => (
                <tr key={d.id} className="border-t border-line">
                  <td className="py-2">
                    <p className="font-medium">{d.name}</p>
                    <p className="text-xs text-muted">{d.phone ?? "No phone"}</p>
                  </td>
                  <td className="num text-right font-semibold text-critical">{formatKes(Number(d.overdue_cents))}</td>
                  <td className="num text-right">{d.invoices}</td>
                  <td className="num text-right">{d.days_overdue}</td>
                  <td className="text-xs">{d.last_reminded_at ? `${d.last_reminded_at.slice(0, 10)} (${d.reminders}×)` : "Never"}</td>
                  <td className="space-x-1 whitespace-nowrap text-right">
                    {d.phone ? (
                      <>
                        <a className={`${link} bg-emerald-50 text-emerald-700`} href={`https://wa.me/${intl(d.phone)}?text=${encodeURIComponent(text(d))}`} target="_blank" rel="noreferrer" onClick={() => log(d, "WHATSAPP")}>WhatsApp</a>
                        <a className={`${link} bg-sky-50 text-sky-700`} href={`sms:${d.phone}?body=${encodeURIComponent(text(d))}`} onClick={() => log(d, "SMS")}>SMS</a>
                        <a className={`${link} bg-surface`} href={`tel:${d.phone}`} onClick={() => log(d, "CALL")}>Call</a>
                      </>
                    ) : (
                      <span className="text-xs text-muted">Add a phone</span>
                    )}
                  </td>
                </tr>
              ))}
              {!debtors.data.length && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-muted">No overdue invoices.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
