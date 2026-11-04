import type { z } from "zod";
import type { tillPromptSchema } from "@kpos/shared";
import { HTTPException } from "hono/http-exception";
import type postgres from "postgres";
import { audit, withTenant } from "./db";
import type { Env } from "./env";
import { promptOutcome, stkPush, toPhone254 } from "./payhero";
import { createDocument, priceLines } from "./routes/documents";
import { requireOpenShift } from "./routes/shifts";
import { resolveBranch } from "./routes/stock";

type Line = { product_id: string; quantity: number; description: string; unit_price_cents: string; tax_code: string; net_cents: string; tax_cents: string; total_cents: string };

/** Prices the sale and sends the prompt. Nothing is recorded as a sale yet: that happens in settleTillPrompt, once the money is confirmed. */
export async function startTillPrompt(env: Env, sql: postgres.Sql, ctx: { bid: string; sub: string }, body: z.infer<typeof tillPromptSchema>, origin: string) {
  const { prompt, settings } = await withTenant(sql, ctx.bid, async (tx) => {
    // A double tap on Charge must not send a second prompt.
    const [dup] = await tx`SELECT id FROM till_prompts WHERE idempotency_key = ${body.idempotencyKey}`;
    if (dup) return { prompt: dup, settings: null };
    const [settings] = await tx`SELECT * FROM payment_settings`;
    if (!settings) throw new HTTPException(409, { message: "PayHero is not set up for this business" });
    await requireOpenShift(tx, ctx.sub);
    const branchId = await resolveBranch(tx, ctx.sub, body.branchId);
    const [cust] = body.customerId ? await tx`SELECT * FROM customers WHERE id = ${body.customerId} AND is_active` : [];
    if (body.customerId && !cust) throw new HTTPException(400, { message: "Unknown customer" });
    const priced = await priceLines(tx, body.lines, cust);
    const total = priced.reduce((s, l) => s + l.t.totalCents, 0);
    if (body.expectedTotalCents !== total) throw new HTTPException(409, { message: `Prices changed since this sale was taken (now ${total / 100}, shown ${body.expectedTotalCents / 100})` });
    if (total <= 0 || total % 100 !== 0) throw new HTTPException(422, { message: "M-Pesa only takes whole shillings. Take this sale by another method." });
    // Better to refuse now than to take money for goods that can't be sold.
    const [biz] = await tx`SELECT allow_negative_stock FROM businesses WHERE id = ${ctx.bid}`;
    if (!biz?.allow_negative_stock) for (const l of priced.filter((x) => x.p.track_stock)) {
      const [bal] = await tx`SELECT on_hand FROM stock_balances WHERE branch_id = ${branchId} AND product_id = ${l.productId}`;
      if (Number(bal?.on_hand ?? 0) < l.quantity) throw new HTTPException(409, { message: `Insufficient stock of ${l.p.name}: ${Number(bal?.on_hand ?? 0)} on hand` });
    }
    const lines: Line[] = priced.map((l) => ({ product_id: l.productId, quantity: l.quantity, description: l.p.name as string, unit_price_cents: String(l.price), tax_code: l.p.tax_code as string,
      net_cents: String(l.t.netCents), tax_cents: String(l.t.taxCents), total_cents: String(l.t.totalCents) }));
    const [prompt] = await tx`INSERT INTO till_prompts (business_id, created_by, branch_id, customer_id, lines, amount_cents, phone, idempotency_key)
      VALUES (${ctx.bid}, ${ctx.sub}, ${branchId}, ${body.customerId ?? null}, ${tx.json(lines as never)}, ${total}, ${toPhone254(body.phone)}, ${body.idempotencyKey}) RETURNING id, amount_cents`;
    await audit(tx, { businessId: ctx.bid, userId: ctx.sub, action: "till.prompt", entity: "till_prompt", entityId: prompt!.id, after: { total } });
    return { prompt: prompt!, settings };
  });
  if (!settings) return { promptId: prompt.id as string };
  const data = await stkPush(env, settings, { amountCents: Number(prompt.amount_cents), phone: body.phone, reference: prompt.id as string, origin });
  await withTenant(sql, ctx.bid, (tx) => data
    ? tx`UPDATE till_prompts SET provider_ref = ${data.reference ?? data.CheckoutRequestID ?? null} WHERE id = ${prompt.id}`
    : tx`UPDATE till_prompts SET status = 'FAILED', settled_at = now(), error = 'PayHero did not accept the request' WHERE id = ${prompt.id}`);
  if (!data) throw new HTTPException(502, { message: "PayHero did not accept the request. No money was taken." });
  return { promptId: prompt.id as string };
}

/** Settles one prompt from PayHero's own status (callback or re-check). On SUCCESS the paid sale is recorded in one transaction. PayHero is asked outside any transaction. */
export async function settleTillPrompt(env: Env, sql: postgres.Sql, bid: string, id: string) {
  const found = await withTenant(sql, bid, async (tx) => {
    const [pay] = await tx`SELECT * FROM till_prompts WHERE id = ${id} AND status = 'PENDING'`;
    const [s] = await tx`SELECT * FROM payment_settings`;
    return pay?.provider_ref && s ? { pay, s } : null;
  });
  if (!found) return;
  const { pay, s } = found;
  const outcome = await promptOutcome(env, s, { id: pay.id as string, provider_ref: pay.provider_ref as string });
  if (!outcome) return;
  const { st, amount } = outcome;
  await withTenant(sql, bid, async (tx) => {
    const [still] = await tx`SELECT id FROM till_prompts WHERE id = ${pay.id} AND status = 'PENDING' FOR UPDATE`;
    if (!still) return; // a concurrent callback already settled it
    if (st.status === "FAILED") {
      await tx`UPDATE till_prompts SET status = 'FAILED', settled_at = now() WHERE id = ${pay.id}`;
      return;
    }
    if (st.status !== "SUCCESS" || amount === undefined) return;
    const review = async (error: string) => {
      await tx`UPDATE till_prompts SET status = 'REVIEW', reference = ${st.provider_reference?.toUpperCase() ?? null}, error = ${error}, settled_at = now() WHERE id = ${pay.id}`;
      await audit(tx, { businessId: bid, action: "till.prompt_review", entity: "till_prompt", entityId: pay.id, after: { error, reference: st.provider_reference } });
    };
    if (Math.round(amount * 100) !== Number(pay.amount_cents)) return review(`PayHero reported KES ${amount}, expected KES ${Number(pay.amount_cents) / 100}`);
    const reference = st.provider_reference!.toUpperCase();
    const lines = pay.lines as Line[];
    try {
      // A savepoint, so a sale that can't be recorded still leaves a record that the customer paid.
      const doc = await tx.savepoint((sp) => createDocument(sp, { bid, sub: pay.created_by as string },
        { type: "SALE", branchId: pay.branch_id as string, customerId: (pay.customer_id as string | null) ?? undefined, idempotencyKey: `stk-${pay.id}`,
          lines: lines.map((l) => ({ productId: l.product_id, quantity: l.quantity })), payments: [{ method: "MPESA", amountCents: Number(pay.amount_cents), reference }] },
        undefined, lines, { paymentAlreadyTaken: true }));
      await tx`UPDATE till_prompts SET status = 'CONFIRMED', reference = ${reference}, document_id = ${doc.id}, settled_at = now() WHERE id = ${pay.id}`;
      await audit(tx, { businessId: bid, action: "payment.mpesa.confirmed", entity: "till_prompt", entityId: pay.id, after: { reference, document: doc.id } });
    } catch (err) {
      if (!(err instanceof HTTPException)) throw err;
      await review(err.message);
    }
  });
}

/** Poll target for the till. Also re-checks with PayHero after a short wait, in case the callback was lost. */
export async function tillPromptStatus(env: Env, sql: postgres.Sql, bid: string, id: string) {
  const read = async () => (await withTenant(sql, bid, (tx) => tx`SELECT p.id, p.status, p.reference, p.error, p.created_at, d.id AS document_id, d.number, d.total_cents
    FROM till_prompts p LEFT JOIN documents d ON d.id = p.document_id WHERE p.id = ${id}`))[0];
  const p = await read();
  if (!p) throw new HTTPException(404, { message: "Prompt not found" });
  if (p.status !== "PENDING" || Date.now() - new Date(p.created_at).getTime() < 20_000) return p;
  await settleTillPrompt(env, sql, bid, id);
  return read();
}
