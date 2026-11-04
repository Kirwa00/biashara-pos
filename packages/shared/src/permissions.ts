export const ROLES = ["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "sales.create", "sales.discount.override", "sales.void", "sales.refund",
  "shift.open", "shift.close", "stock.view", "stock.adjust", "stock.adjust.approve",
  "catalog.manage", "customers.manage", "customers.credit", "invoices.manage", "documents.create", "payments.record",
  "reports.view", "users.manage", "branches.manage", "settings.payments", "settings.etims", "audit.view", "data.export", "billing.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** A cashier or teller only sells: till sales, quotations and invoices, for customers they can add, on their own shift. No stock, suppliers, reports or settings. */
const CASHIER: Permission[] = ["sales.create", "documents.create", "shift.open", "shift.close", "customers.manage", "payments.record"];
const ACCOUNTANT: Permission[] = ["stock.view", "invoices.manage", "documents.create", "payments.record", "reports.view", "audit.view", "customers.manage"];
const MANAGER: Permission[] = [...new Set<Permission>([...CASHIER, ...ACCOUNTANT,
  "sales.discount.override", "sales.void", "sales.refund", "stock.adjust", "stock.adjust.approve", "catalog.manage", "customers.credit"])];

export const ROLE_LABELS: Record<Role, string> = { OWNER: "Owner", MANAGER: "Manager", ACCOUNTANT: "Accountant", CASHIER: "Cashier / Teller" };

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  MANAGER,
  ACCOUNTANT,
  CASHIER,
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
