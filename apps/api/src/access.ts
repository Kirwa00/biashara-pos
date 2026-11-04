import { billingState, planCaps, type Plan } from "@kpos/shared";
import { HTTPException } from "hono/http-exception";
import type postgres from "postgres";
import { withTenant } from "./db";
import type { Env } from "./env";

/** The business that sells BiasharaPOS: the first registered SUPER_ADMIN_EMAILS address. Null means billing is off, and nobody is restricted. */
export async function sellerBusinessId(env: Env, sql: postgres.Sql): Promise<string | null> {
  for (const email of (env.SUPER_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim()).filter(Boolean)) {
    const [u] = await sql`SELECT business_id FROM auth_lookup(${email})`;
    if (u) return u.business_id as string;
  }
  return null;
}

/** Writes are refused once the grace period is over. Reads stay open so a business can always see and export its own records. */
export async function assertNotLapsed(env: Env, sql: postgres.Sql, bid: string) {
  const [b] = await withTenant(sql, bid, (tx) => tx`SELECT trial_ends_at, paid_until FROM businesses WHERE id = ${bid}`);
  if (!b || billingState({ trial_ends_at: b.trial_ends_at, paid_until: b.paid_until }).kind !== "LAPSED") return;
  const seller = await sellerBusinessId(env, sql);
  if (!seller || seller === bid) return;
  throw new HTTPException(402, { message: "Your BiasharaPOS subscription has ended. Your records are safe: pay in Billing to carry on selling." });
}

export type Caps = { name: string; branches: number | null; products: number | null };

/** The limits to enforce for this business, or null when it has none (the seller, or billing is off). Read before the write's transaction. */
export async function capsFor(env: Env, sql: postgres.Sql, bid: string): Promise<Caps | null> {
  const seller = await sellerBusinessId(env, sql);
  if (!seller || seller === bid) return null;
  const [b] = await withTenant(sql, bid, (tx) => tx`SELECT plan FROM businesses WHERE id = ${bid}`);
  return planCaps((b?.plan ?? null) as Plan | null);
}

/** Checked after the insert, inside its transaction, so a CSV import that would pass the limit rolls back whole. */
export async function assertWithinCaps(tx: postgres.TransactionSql, caps: Caps | null, what: "branches" | "products") {
  const limit = caps?.[what];
  if (limit === null || limit === undefined) return;
  const [r] = what === "branches"
    ? await tx`SELECT count(*)::int AS n FROM branches WHERE is_active`
    : await tx`SELECT count(*)::int AS n FROM products WHERE is_active`;
  if (r!.n > limit) throw new HTTPException(409, { message: `${caps!.name} includes up to ${limit.toLocaleString("en-KE")} ${what === "branches" ? (limit === 1 ? "branch" : "branches") : "products"}. Upgrade in Billing to add more.` });
}
