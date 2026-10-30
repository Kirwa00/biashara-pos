import { paymentSettingsSchema, stkPushSchema } from "@kpos/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth, requirePermission } from "../auth";
import { decryptSecret, encryptSecret, randomToken } from "../crypto";
import { audit, withTenant } from "../db";
import type { AppEnv } from "../env";
import { amountShillings, base, key, payheroGet, type TxStatus } from "../payhero";
import { applyPayment } from "./documents";
import { currentShiftId } from "./shifts";

const basic = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`;
const toPhone254 = (p: string) => p.replace(/^\+/, "").replace(/^0/, "254");

/** Business-scoped PayHero settings and STK push. */
export const paymentRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/settings/payments", requirePermission("settings.payments"), async (c) => {
    const [s] = await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`SELECT payhero_username, channel_id, callback_token, updated_at FROM payment_settings`);
    const origin = new URL(c.req.url).origin;
    return c.json(s ? { configured: true, username: s.payhero_username, channelId: s.channel_id, callbackUrl: `${origin}/v1/webhooks/payhero/${s.callback_token}`, updatedAt: s.updated_at } : { configured: false });
  })
  .put("/settings/payments", requirePermission("settings.payments"), zValidator("json", paymentSettingsSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const b = c.req.valid("json");
    const enc = await encryptSecret(key(c.env), b.password);
    await withTenant(c.get("sql"), bid, async (tx) => {
      await tx`INSERT INTO payment_settings (business_id, payhero_username, payhero_password_enc, channel_id, callback_token)
        VALUES (${bid}, ${b.username}, ${enc}, ${b.channelId}, ${randomToken(24)})
        ON CONFLICT (business_id) DO UPDATE SET payhero_username = EXCLUDED.payhero_username, payhero_password_enc = EXCLUDED.payhero_password_enc,
          channel_id = EXCLUDED.channel_id, updated_at = now()`;
      await audit(tx, { businessId: bid, userId: sub, action: "settings.payments.update", entity: "payment_settings", after: { username: b.username, channelId: b.channelId } });
    });
    return c.json({ configured: true });
  })
  .post("/payments/stk", requirePermission("payments.record"), zValidator("json", stkPushSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const b = c.req.valid("json");
    const sql = c.get("sql");
    const { pay, s } = await withTenant(sql, bid, async (tx) => {
      const [s] = await tx`SELECT * FROM payment_settings`;
      if (!s) throw new HTTPException(409, { message: "PayHero is not set up for this business" });
      const [doc] = await tx`SELECT * FROM documents WHERE id = ${b.documentId} AND type <> 'QUOTE'`;
      if (!doc) throw new HTTPException(404, { message: "Invoice not found" });
      if (b.amountCents > Number(doc.total_cents) - Number(doc.paid_cents)) throw new HTTPException(422, { message: "Amount exceeds balance" });
      const [pay] = await tx`INSERT INTO payments (business_id, document_id, method, amount_cents, status, phone, created_by)
        VALUES (${bid}, ${doc.id}, 'MPESA', ${b.amountCents}, 'PENDING', ${toPhone254(b.phone)}, ${sub}) RETURNING id`;
      return { pay: pay!, s };
    });
    const password = await decryptSecret(key(c.env), s.payhero_password_enc);
    const res = await fetch(`${base(c.env)}/api/v2/payments`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: basic(s.payhero_username, password) },
      body: JSON.stringify({ amount: b.amountCents / 100, phone_number: toPhone254(b.phone), channel_id: s.channel_id, provider: "m-pesa",
        external_reference: pay.id, callback_url: `${new URL(c.req.url).origin}/v1/webhooks/payhero/${s.callback_token}` }),
    }).catch(() => null);
    const data = res?.ok ? ((await res.json()) as { reference?: string; CheckoutRequestID?: string }) : null;
    await withTenant(sql, bid, (tx) => data
      ? tx`UPDATE payments SET provider_ref = ${data.reference ?? data.CheckoutRequestID ?? null} WHERE id = ${pay.id}`
      : tx`UPDATE payments SET status = 'FAILED' WHERE id = ${pay.id}`);
    if (!data) throw new HTTPException(502, { message: "PayHero did not accept the request" });
    return c.json({ paymentId: pay.id, status: "PENDING" }, 202);
  })
  .get("/payments/:id", async (c) => {
    const [p] = await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`SELECT id, document_id, method, amount_cents, reference, status, created_at FROM payments WHERE id = ${c.req.param("id")}`);
    if (!p) throw new HTTPException(404, { message: "Payment not found" });
    return c.json(p);
  });

/** Public PayHero callback. The body is untrusted: we only use it to find the payment, then confirm with PayHero. */
export const webhookRoutes = new Hono<AppEnv>().post("/payhero/:token", async (c) => {
  const sql = c.get("sql");
  const [row] = await sql`SELECT payhero_token_lookup(${c.req.param("token")}) AS bid`;
  if (!row?.bid) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { response?: { ExternalReference?: string } };
  const ref = body.response?.ExternalReference;
  if (!ref || !/^[0-9a-f-]{36}$/i.test(ref)) return c.json({ ok: true });
  await withTenant(sql, row.bid as string, async (tx) => {
    const [pay] = await tx`SELECT * FROM payments WHERE id = ${ref} AND status = 'PENDING' FOR UPDATE`;
    if (!pay?.provider_ref) return;
    const [s] = await tx`SELECT * FROM payment_settings`;
    const st = await payheroGet<TxStatus>(c.env, s!, `/api/v2/transaction-status?reference=${encodeURIComponent(pay.provider_ref)}`);
    if (!st) return;
    const sameTx = (st.reference ?? pay.provider_ref) === pay.provider_ref && (st.external_reference ?? pay.id) === pay.id;
    if (st.status === "SUCCESS") {
      const amount = sameTx && st.provider_reference ? await amountShillings(c.env, s!, st) : undefined;
      if (amount === undefined || Math.round(amount * 100) !== Number(pay.amount_cents)) return;
      const [doc] = await tx`SELECT * FROM documents WHERE id = ${pay.document_id} FOR UPDATE`;
      await applyPayment(tx, doc!, Number(pay.amount_cents));
      // Shift is assigned at confirmation so a closed shift's Z totals never change; late confirmations land on the cashier's next open shift.
      await tx`UPDATE payments SET status = 'CONFIRMED', reference = ${st.provider_reference!.toUpperCase()}, shift_id = ${currentShiftId(tx, pay.created_by)} WHERE id = ${pay.id}`;
      await audit(tx, { businessId: row.bid as string, action: "payment.mpesa.confirmed", entity: "payment", entityId: pay.id, after: st });
    } else if (st.status === "FAILED") {
      await tx`UPDATE payments SET status = 'FAILED' WHERE id = ${pay.id}`;
    }
  });
  return c.json({ ok: true });
});
