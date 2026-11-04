import { z } from "zod";
import { kenyanPhone } from "./schemas";

/** Default prices seed the seller's catalog once; after that the catalog's price is what clients pay. Annual is twelve months, charged at once. */
export const PLANS = {
  STARTER: { name: "Biashara Starter", monthlyCents: 360_000, branches: 1, products: 1_000 },
  COMMERCIAL: { name: "Commercial Wholesale", monthlyCents: 1_480_000, branches: 5, products: 50_000 },
  ENTERPRISE: { name: "Enterprise", monthlyCents: null, branches: null, products: null },
} as const;
export type Plan = keyof typeof PLANS;
export const SELF_SERVE_PLANS = ["STARTER", "COMMERCIAL"] as const;
export const BILLING_CYCLES = ["MONTHLY", "ANNUAL"] as const;
export type SelfServePlan = (typeof SELF_SERVE_PLANS)[number];
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const planSku = (plan: SelfServePlan, cycle: BillingCycle) => `PLAN-${plan}-${cycle}`;

export const billingChoiceSchema = z.object({ plan: z.enum(SELF_SERVE_PLANS), cycle: z.enum(BILLING_CYCLES), phone: kenyanPhone });
export const adminSubscriptionSchema = z.object({
  plan: z.enum(["STARTER", "COMMERCIAL", "ENTERPRISE"]),
  cycle: z.enum(BILLING_CYCLES),
  paidUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
});

export const GRACE_DAYS = 3;
const DAY_MS = 86_400_000;

export type BillingStateKind = "TRIAL" | "ACTIVE" | "GRACE" | "LAPSED";
export type BillingState = { kind: BillingStateKind; endsAt: string; daysLeft: number };

/** Where a business stands. After the paid or trial period there are GRACE_DAYS of warnings, then it is read-only until it pays. */
export function billingState(b: { trial_ends_at: string | Date; paid_until?: string | Date | null }, now = new Date()): BillingState {
  const trial = new Date(b.trial_ends_at).getTime();
  const paid = b.paid_until ? new Date(b.paid_until).getTime() : 0;
  const end = Math.max(trial, paid);
  const left = end - now.getTime();
  const kind: BillingStateKind = left > 0 ? (paid > 0 ? "ACTIVE" : "TRIAL") : left >= -GRACE_DAYS * DAY_MS ? "GRACE" : "LAPSED";
  return { kind, endsAt: new Date(end).toISOString(), daysLeft: Math.ceil(left / DAY_MS) };
}

/** Limits for a business: trials get the Commercial limits so nothing is cut short while trying the app. */
export const planCaps = (plan: Plan | null | undefined) => PLANS[plan ?? "COMMERCIAL"];
