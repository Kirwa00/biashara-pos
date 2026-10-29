export const ROLES = ["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "sales.create", "sales.discount.override", "sales.void", "sales.refund",
  "shift.open", "shift.close", "stock.view", "stock.adjust", "stock.adjust.approve",
  "catalog.manage", "customers.manage", "invoices.manage", "payments.record",
  "reports.view", "users.manage", "branches.manage", "settings.payments", "audit.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const CASHIER: Permission[] = ["sales.create", "shift.open", "shift.close", "stock.view", "customers.manage", "payments.record"];
const ACCOUNTANT: Permission[] = ["stock.view", "invoices.manage", "payments.record", "reports.view", "audit.view", "customers.manage"];
const MANAGER: Permission[] = [...new Set<Permission>([...CASHIER, ...ACCOUNTANT,
  "sales.discount.override", "sales.void", "sales.refund", "stock.adjust", "stock.adjust.approve", "catalog.manage"])];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  MANAGER,
  ACCOUNTANT,
  CASHIER,
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
