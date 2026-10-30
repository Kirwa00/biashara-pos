import { HTTPException } from "hono/http-exception";
import type postgres from "postgres";
import { decryptSecret } from "./crypto";
import { withTenant } from "./db";
import type { Env } from "./env";

export const base = (env: Env) => env.PAYHERO_BASE_URL ?? "https://backend.payhero.co.ke";
export const key = (env: Env) => {
  if (!env.ENCRYPTION_KEY) throw new HTTPException(500, { message: "ENCRYPTION_KEY not configured" });
  return env.ENCRYPTION_KEY;
};
const basic = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`;

export type TxStatus = { status?: string; provider_reference?: string; amount?: number; reference?: string; external_reference?: string };

/** Authenticated GET against the business's own PayHero account; null when PayHero is unreachable. */
export async function payheroGet<T>(env: Env, s: postgres.Row, path: string): Promise<T | null> {
  const auth = basic(s.payhero_username, await decryptSecret(key(env), s.payhero_password_enc));
  const res = await fetch(`${base(env)}${path}`, { headers: { authorization: auth } }).catch(() => null);
  return res?.ok ? ((await res.json()) as T) : null;
}

/** PayHero's status response may omit the amount; fall back to the recent account transactions list. */
export async function amountShillings(env: Env, s: postgres.Row, st: TxStatus): Promise<number | undefined> {
  if (st.amount !== undefined) return st.amount;
  const code = st.provider_reference?.toUpperCase();
  for (let page = 1; code && page <= 3; page++) {
    const r = await payheroGet<{ transactions?: { amount: number; transaction_reference?: string }[]; pagination?: { next_page?: number | null } }>(env, s, `/api/v2/transactions?page=${page}&per=100`);
    const hit = r?.transactions?.find((t) => t.transaction_reference?.toUpperCase() === code && t.amount > 0);
    if (hit) return hit.amount;
    if (!r?.pagination?.next_page) break;
  }
  return undefined;
}

type Pay = { method: string; amountCents: number; reference?: string };

/**
 * Hand-entered M-Pesa codes are confirmed automatically: PayHero must report the code as SUCCESS for the exact amount.
 * Businesses without PayHero keep the manual fallback. Codes are normalised to upper case.
 */
export async function verifyMpesaCodes<P extends Pay>(env: Env, sql: postgres.Sql, bid: string, payments: P[]): Promise<P[]> {
  const mpesa = payments.filter((p) => p.method === "MPESA" && p.reference);
  if (!mpesa.length) return payments;
  const [s] = await withTenant(sql, bid, (tx) => tx`SELECT * FROM payment_settings`);
  const out = payments.map((p) => (p.method === "MPESA" && p.reference ? { ...p, reference: p.reference.toUpperCase() } : p));
  if (!s) return out;
  for (const p of out) {
    if (p.method !== "MPESA" || !p.reference) continue;
    const st = await payheroGet<TxStatus>(env, s, `/api/v2/transaction-status?reference=${encodeURIComponent(p.reference)}`);
    if (!st) throw new HTTPException(503, { message: "Couldn't reach PayHero to check the M-Pesa code — try again" });
    if (st.status !== "SUCCESS" || st.provider_reference?.toUpperCase() !== p.reference)
      throw new HTTPException(422, { message: `M-Pesa code ${p.reference} was not found as a completed payment` });
    const amount = await amountShillings(env, s, st);
    if (amount === undefined || Math.round(amount * 100) !== p.amountCents)
      throw new HTTPException(422, { message: `M-Pesa code ${p.reference} is for ${amount === undefined ? "an unknown amount" : `KES ${amount}`}, not KES ${p.amountCents / 100}` });
  }
  return out;
}
