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
/** An empty username means the stored secret is PayHero's ready-made Basic token. */
const authHeader = async (env: Env, s: postgres.Row) => {
  const secret = await decryptSecret(key(env), s.payhero_password_enc);
  return s.payhero_username ? basic(s.payhero_username, secret) : `Basic ${secret}`;
};

export type TxStatus = { status?: string; provider_reference?: string; amount?: number; reference?: string; external_reference?: string; channel_id?: number | string };

/** One PayHero account can hold several channels; when PayHero names the channel it must be this business's. */
export const sameChannel = (s: postgres.Row, ch?: number | string | null) => ch == null || Number(ch) === Number(s.channel_id);

/** Authenticated GET against the business's own PayHero account; null when PayHero is unreachable. */
export async function payheroGet<T>(env: Env, s: postgres.Row, path: string): Promise<T | null> {
  const res = await fetch(`${base(env)}${path}`, { headers: { authorization: await authHeader(env, s) } }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
}

/** PayHero's status response may omit the amount; fall back to the recent account transactions list. */
export async function amountShillings(env: Env, s: postgres.Row, st: TxStatus): Promise<number | undefined> {
  if (st.amount !== undefined) return st.amount;
  const code = st.provider_reference?.toUpperCase();
  for (let page = 1; code && page <= 3; page++) {
    const r = await payheroGet<{ transactions?: { amount: number; transaction_reference?: string; channel_id?: number | string | null }[]; pagination?: { next_page?: number | null } }>(env, s, `/api/v2/transactions?page=${page}&per=100`);
    const hit = r?.transactions?.find((t) => t.transaction_reference?.toUpperCase() === code && t.amount > 0 && sameChannel(s, t.channel_id));
    if (hit) return hit.amount;
    if (!r?.pagination?.next_page) break;
  }
  return undefined;
}

type Channel = { id: number; description?: string; short_code?: string; channel_type?: string; is_active?: boolean };
export type PayHeroCheck =
  | { ok: true; channel: { id: number; description: string | null; shortCode: string | null }; walletBalanceCents: number | null }
  | { ok: false; reason: "UNREACHABLE" | "REJECTED" | "CHANNEL"; message: string };

/** Proves an Authorization header works and that the channel is this account's and active, by asking PayHero. Sends no payment. */
export async function checkPayHero(env: Env, authorization: string, channelId: number): Promise<PayHeroCheck> {
  const get = (path: string) => fetch(`${base(env)}${path}`, { headers: { authorization, "content-type": "application/json" } }).catch(() => null);
  const channels: Channel[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await get(`/api/v2/payment_channels?page=${page}&per=100`);
    if (!res || res.status >= 500 || res.status === 429) return { ok: false, reason: "UNREACHABLE", message: "Couldn't reach PayHero. Nothing was changed; try again in a moment." };
    if (!res.ok) return { ok: false, reason: "REJECTED", message: "PayHero rejected this token. Copy the Basic Authorization token again from API Keys in your PayHero dashboard." };
    const body = (await res.json().catch(() => null)) as { payment_channels?: Channel[]; pagination?: { next_page?: number | null } } | null;
    channels.push(...(body?.payment_channels ?? []));
    if (!body?.pagination?.next_page) break;
  }
  const channel = channels.find((c) => Number(c.id) === channelId);
  const known = channels.map((c) => `${c.id}${c.description ? ` (${c.description})` : ""}`).join(", ");
  if (!channel) return { ok: false, reason: "CHANNEL", message: `Channel ${channelId} isn't on this PayHero account. ${known ? `Your channels: ${known}.` : "This account has no payment channels yet."}` };
  if (channel.is_active === false) return { ok: false, reason: "CHANNEL", message: `Channel ${channelId} is switched off in PayHero. Activate it under Payment Channels.` };
  const wallet = await get("/api/v2/wallets?wallet_type=service_wallet");
  const balance = wallet?.ok ? ((await wallet.json().catch(() => null)) as { available_balance?: number } | null)?.available_balance : undefined;
  return { ok: true, channel: { id: channelId, description: channel.description ?? null, shortCode: channel.short_code ?? null }, walletBalanceCents: typeof balance === "number" ? Math.round(balance * 100) : null };
}
/** The same check on what is already saved for a business. */
export const checkSavedPayHero = async (env: Env, s: postgres.Row) => checkPayHero(env, await authHeader(env, s), s.channel_id as number);

export const toPhone254 = (p: string) => p.replace(/^\+/, "").replace(/^0/, "254");
/** PayHero documents phone numbers as 07… or 01…. */
const toLocalPhone = (p: string) => p.replace(/^\+/, "").replace(/^254/, "0");

/** Sends an M-Pesa prompt from the business's PayHero account; null when PayHero didn't accept it. */
export async function stkPush(env: Env, s: postgres.Row, p: { amountCents: number; phone: string; reference: string; origin: string }) {
  const res = await fetch(`${base(env)}/api/v2/payments`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: await authHeader(env, s) },
    body: JSON.stringify({ amount: p.amountCents / 100, phone_number: toLocalPhone(p.phone), channel_id: s.channel_id, provider: "m-pesa",
      external_reference: p.reference, callback_url: `${p.origin}/v1/webhooks/payhero/${s.callback_token}` }),
  }).catch(() => null);
  // PayHero's reason is the only clue when a prompt is refused; it holds no credentials.
  if (!res?.ok) console.error(`PayHero refused a prompt: ${res?.status ?? "no response"} ${res ? (await res.text().catch(() => "")).slice(0, 300) : ""}`);
  return res?.ok ? ((await res.json()) as { reference?: string; CheckoutRequestID?: string }) : null;
}

/** What PayHero says happened to a prompt. `amount` is set only for a SUCCESS that is verifiably this transaction. Null when PayHero is unreachable. */
export async function promptOutcome(env: Env, s: postgres.Row, pay: { id: string; provider_ref: string }) {
  const st = await payheroGet<TxStatus>(env, s, `/api/v2/transaction-status?reference=${encodeURIComponent(pay.provider_ref)}`);
  if (!st) return null;
  const sameTx = (st.reference ?? pay.provider_ref) === pay.provider_ref && (st.external_reference ?? pay.id) === pay.id && sameChannel(s, st.channel_id);
  const amount = st.status === "SUCCESS" && sameTx && st.provider_reference ? await amountShillings(env, s, st) : undefined;
  return { st, amount };
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
    if (st.status !== "SUCCESS" || st.provider_reference?.toUpperCase() !== p.reference || !sameChannel(s, st.channel_id))
      throw new HTTPException(422, { message: `M-Pesa code ${p.reference} was not found as a completed payment` });
    const amount = await amountShillings(env, s, st);
    if (amount === undefined || Math.round(amount * 100) !== p.amountCents)
      throw new HTTPException(422, { message: `M-Pesa code ${p.reference} is for ${amount === undefined ? "an unknown amount" : `KES ${amount}`}, not KES ${p.amountCents / 100}` });
  }
  return out;
}
