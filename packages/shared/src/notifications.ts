export const NOTIFICATION_KINDS = ["LOW_STOCK", "OVERDUE_INVOICES", "PAYMENT_ISSUES", "PO_ACTION", "DAILY_SUMMARY", "ETIMS_ISSUES"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_LABELS: Record<NotificationKind, string> = {
  LOW_STOCK: "Low stock",
  OVERDUE_INVOICES: "Overdue invoices",
  PAYMENT_ISSUES: "M-Pesa payments",
  PO_ACTION: "Purchase orders",
  DAILY_SUMMARY: "Daily summary",
  ETIMS_ISSUES: "eTIMS",
};

export type Notification = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  data: Record<string, unknown>;
  email_status: "PENDING" | "SENT" | "FAILED" | "SKIPPED";
  read_at: string | null;
  created_at: string;
};
