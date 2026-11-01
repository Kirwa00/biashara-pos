import { NOTIFICATION_LABELS, type Notification } from "@kpos/shared";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { Card, Note, useLoad } from "./ui";

const TONE: Record<Notification["kind"], string> = {
  LOW_STOCK: "bg-amber-50 text-amber-700",
  OVERDUE_INVOICES: "bg-red-50 text-critical",
  PAYMENT_ISSUES: "bg-red-50 text-critical",
  PO_ACTION: "bg-sky-50 text-sky-700",
  DAILY_SUMMARY: "bg-primary/10 text-primary",
  ETIMS_ISSUES: "bg-amber-50 text-amber-700",
};
const LINK: Partial<Record<Notification["kind"], string>> = { LOW_STOCK: "/inventory", OVERDUE_INVOICES: "/reminders", PAYMENT_ISSUES: "/sales", PO_ACTION: "/purchase-orders", DAILY_SUMMARY: "/reports", ETIMS_ISSUES: "/etims" };
const EMAIL: Record<Notification["email_status"], string> = { PENDING: "Email queued", SENT: "Emailed to owners", FAILED: "Email failed, will retry", SKIPPED: "In-app only" };

/** Notification centre: alerts from the 08:00 and 20:00 jobs. Read state is shared by everyone in the business. */
export function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const list = useLoad<{ unread: number; items: Notification[] }>(`/notifications${unreadOnly ? "?unread=1" : ""}`, { unread: 0, items: [] });
  const [msg, setMsg] = useState("");

  const act = async (path: string) => {
    try {
      await api(path, { method: "POST", body: "{}" });
      list.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <Note msg={msg || list.msg} />
      <Card title={`Notifications · ${list.data.unread} unread`}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted">Low stock, overdue invoices, M-Pesa issues and purchase orders at 08:00; the daily summary at 20:00.</p>
          <div className="flex gap-2">
            <button onClick={() => setUnreadOnly(!unreadOnly)} className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted hover:bg-surface">
              {unreadOnly ? "Show all" : "Unread only"}
            </button>
            <button onClick={() => act("/notifications/read-all")} disabled={!list.data.unread} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">
              Mark all read
            </button>
          </div>
        </div>
        <ul className="divide-y divide-line">
          {list.data.items.map((n) => (
            <li key={n.id} className={`flex gap-3 py-3 ${n.read_at ? "opacity-60" : ""}`}>
              <span className={`mt-0.5 h-fit shrink-0 rounded px-2 py-0.5 text-[11px] font-bold uppercase ${TONE[n.kind]}`}>{NOTIFICATION_LABELS[n.kind]}</span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-ink">{n.title}</p>
                <p className="whitespace-pre-line text-sm text-muted">{n.body}</p>
                <p className="mt-1 text-[11px] text-muted">
                  {new Date(n.created_at).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" })} · {EMAIL[n.email_status]}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
                {LINK[n.kind] && <Link to={LINK[n.kind]!} className="font-semibold text-primary hover:underline">Open</Link>}
                {!n.read_at && <button onClick={() => act(`/notifications/${n.id}/read`)} className="text-muted hover:text-ink">Mark read</button>}
              </div>
            </li>
          ))}
          {!list.data.items.length && <li className="py-6 text-center text-muted">{unreadOnly ? "All caught up." : "No notifications yet."}</li>}
        </ul>
      </Card>
    </div>
  );
}
