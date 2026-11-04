import { billingState, computeLine, planCaps, PLANS, planSku, SELF_SERVE_PLANS, BILLING_CYCLES, type BillingCycle, type SelfServePlan, type TaxCode } from "@kpos/shared";
import { HTTPException } from "hono/http-exception";
import type postgres from "postgres";
import { sellerBusinessId } from "./access";
import { audit, withTenant } from "./db";
import type { Env } from "./env";
import { emailPending, nairobiDate } from "./jobs";
import { promptOutcome, stkPush, toPhone254 } from "./payhero";
import { createDocument } from "./routes/documents";

/** A prompt waiting longer than this is re-checked with PayHero, in case its callback was lost. */
const STK_WAIT_MS = 3 * 60_000;
export type Choice = { plan: SelfServePlan; cycle: BillingCycle; phone: string };

/** The seller's plans are ordinary products, so the owner can reprice them and they show up in reports. Created once; never overwritten. */
async function ensurePlanProducts(tx: postgres.TransactionSql, seller: string) {
  for (const plan of SELF_SERVE_PLANS) for (const cycle of BILLING_CYCLES) {
    const { name, monthlyCents } = PLANS[plan];
    await tx`INSERT INTO products (business_id, sku, name, retail_price_cents, track_stock)
      VALUES (${seller}, ${planSku(plan, cycle)}, ${`${name} (${cycle === "ANNUAL" ? "annual" : "monthly"})`}, ${monthlyCents * (cycle === "ANNUAL" ? 12 : 1)}, false)
      ON CONFLICT (business_id, sku) DO NOTHING`;
  }
}

export async function planPrices(sql: postgres.Sql, seller: string) {
  return withTenant(sql, seller, async (tx) => {
    await ensurePlanProducts(tx, seller);
    const rows = await tx`SELECT sku, retail_price_cents, tax_code, price_includes_tax FROM products WHERE is_active AND sku LIKE 'PLAN-%'`;
    return SELF_SERVE_PLANS.flatMap((plan) => BILLING_CYCLES.flatMap((cycle) => {
      const p = rows.find((r) => r.sku === planSku(plan, cycle));
      if (!p) return [];
      const total = computeLine({ unitPriceCents: Number(p.retail_price_cents), quantity: 1, taxCode: p.tax_code as TaxCode, priceIncludesTax: p.price_includes_tax }).totalCents;
      return [{ plan, cycle, name: PLANS[plan].name, amountCents: total, branches: PLANS[plan].branches, products: PLANS[plan].products }];
    }));
  });
}

/** State for the app banner. Null when the business isn't billed: the seller itself, or billing not set up. */
export async function billingSummary(env: Env, sql: postgres.Sql, bid: string) {
  const seller = await sellerBusinessId(env, sql);
  if (!seller || seller === bid) return null;
  const [b] = await withTenant(sql, bid, (tx) => tx`SELECT trial_ends_at, paid_until FROM businesses WHERE id = ${bid}`);
  return b ? billingState({ trial_ends_at: b.trial_ends_at, paid_until: b.paid_until }) : null;
}

/** A smaller plan must still fit what the business already has. */
export async function assertPlanFits(sql: postgres.Sql, bid: string, plan: SelfServePlan) {
  const caps = planCaps(plan);
  const [n] = await withTenant(sql, bid, (tx) => tx`SELECT (SELECT count(*)::int FROM branches WHERE is_active) AS branches, (SELECT count(*)::int FROM products WHERE is_active) AS products`);
  if (caps.branches !== null && n!.branches > caps.branches) throw new HTTPException(409, { message: `${caps.name} includes ${caps.branches} branch${caps.branches === 1 ? "" : "es"}, and you have ${n!.branches}. Choose a bigger plan or close a branch first.` });
  if (caps.products !== null && n!.products > caps.products) throw new HTTPException(409, { message: `${caps.name} includes ${caps.products.toLocaleString("en-KE")} products, and you have ${n!.products.toLocaleString("en-KE")}. Choose a bigger plan first.` });
}

export async function saveChoice(sql: postgres.Sql, bid: string, c: Choice) {
  await withTenant(sql, bid, async (tx) => {
    await tx`UPDATE businesses SET next_plan = ${c.plan}, billing_cycle = ${c.cycle}, billing_phone = ${toPhone254(c.phone)} WHERE id = ${bid}`;
  });
}

/** Sends an M-Pesa prompt for a subscription. The seller's invoice is created only when the money is confirmed (settleSubscriptionPrompt). */
export async function startPrompt(env: Env, sql: postgres.Sql, seller: string, bid: string, c: Choice, origin: string, source: "OWNER" | "AUTO") {
  await settleStale(env, sql, seller, bid);
  await assertPlanFits(sql, bid, c.plan);
  const [client] = await withTenant(sql, bid, (tx) => tx`SELECT name, phone, kra_pin, billing_customer_id FROM businesses WHERE id = ${bid}`);
  const phone = toPhone254(c.phone);
  const { s, customerId, line, amount } = await withTenant(sql, seller, async (tx) => {
    const [s] = await tx`SELECT * FROM payment_settings`;
    if (!s) throw new HTTPException(503, { message: "Online payment isn't available right now. Please contact BiasharaPOS support." });
    await ensurePlanProducts(tx, seller);
    const [p] = await tx`SELECT * FROM products WHERE is_active AND sku = ${planSku(c.plan, c.cycle)}`;
    if (!p) throw new HTTPException(409, { message: "That plan isn't available right now. Please contact BiasharaPOS support." });
    const t = computeLine({ unitPriceCents: Number(p.retail_price_cents), quantity: 1, taxCode: p.tax_code as TaxCode, priceIncludesTax: p.price_includes_tax });
    if (t.totalCents <= 0 || t.totalCents % 100 !== 0) throw new HTTPException(409, { message: "That plan's price can't be charged by M-Pesa. Please contact BiasharaPOS support." });
    // The client is an ordinary customer in the seller's books; the id is kept on the client's row (saved below).
    const [known] = client!.billing_customer_id ? await tx`SELECT id FROM customers WHERE id = ${client!.billing_customer_id}` : [];
    // Phone numbers are unique among customers, but one person can own several shops: leave it blank rather than merge their accounts.
    const phoneFree = client!.phone && !(await tx`SELECT 1 FROM customers WHERE phone = ${client!.phone}`).length;
    const customerId = (known ?? (await tx`INSERT INTO customers (business_id, name, phone, kra_pin) VALUES (${seller}, ${client!.name}, ${phoneFree ? client!.phone : null}, ${client!.kra_pin}) RETURNING id`)[0]!).id as string;
    return { s, customerId, amount: t.totalCents,
      line: { product_id: p.id as string, description: p.name as string, unit_price_cents: String(p.retail_price_cents), tax_code: p.tax_code as string, net_cents: String(t.netCents), tax_cents: String(t.taxCents), total_cents: String(t.totalCents) } };
  });
  const pay = await withTenant(sql, bid, async (tx) => {
    // The row lock and the one-pending index mean a client can never have two prompts out at once.
    await tx`SELECT id FROM businesses WHERE id = ${bid} FOR UPDATE`;
    if ((await tx`SELECT 1 FROM subscription_payments WHERE business_id = ${bid} AND status = 'PENDING'`).length)
      throw new HTTPException(409, { message: "An M-Pesa prompt is already waiting. Check your phone, or try again in a few minutes." });
    await tx`UPDATE businesses SET billing_customer_id = ${customerId}, billing_cycle = ${c.cycle}, billing_phone = ${phone}, next_plan = ${c.plan} WHERE id = ${bid}`;
    const [row] = await tx`INSERT INTO subscription_payments (business_id, seller_business_id, customer_id, plan, cycle, amount_cents, line, phone, source)
      VALUES (${bid}, ${seller}, ${customerId}, ${c.plan}, ${c.cycle}, ${amount}, ${tx.json(line)}, ${phone}, ${source}) RETURNING id`;
    await audit(tx, { businessId: bid, action: "billing.prompt", entity: "subscription_payment", entityId: row!.id, after: { plan: c.plan, cycle: c.cycle, amount, source } });
    return row!;
  });
  const data = await stkPush(env, s, { amountCents: amount, phone, reference: pay.id as string, origin });
  await withTenant(sql, bid, (tx) => data
    ? tx`UPDATE subscription_payments SET provider_ref = ${data.reference ?? data.CheckoutRequestID ?? null} WHERE id = ${pay.id}`
    : tx`UPDATE subscription_payments SET status = 'FAILED', settled_at = now() WHERE id = ${pay.id}`);
  if (!data) throw new HTTPException(502, { message: "PayHero did not accept the request. Please try again." });
  return { paymentId: pay.id as string, amountCents: amount };
}

async function settleStale(env: Env, sql: postgres.Sql, seller: string, bid: string) {
  const stale = await withTenant(sql, bid, (tx) => tx`SELECT id, provider_ref, created_at FROM subscription_payments WHERE business_id = ${bid} AND status = 'PENDING'`);
  for (const p of stale) {
    if (Date.now() - new Date(p.created_at).getTime() < STK_WAIT_MS) continue;
    // PayHero never took this one: nothing can be charged, so don't let it block the client.
    if (!p.provider_ref) await withTenant(sql, bid, (tx) => tx`UPDATE subscription_payments SET status = 'FAILED', settled_at = now() WHERE id = ${p.id} AND status = 'PENDING' AND provider_ref IS NULL`);
    else await settleSubscriptionPrompt(env, sql, seller, p.id as string);
  }
}

/**
 * Settles one subscription prompt from PayHero's own status (callback or re-check). On SUCCESS, in one transaction: a paid invoice in the seller's books
 * and more time on the client's subscription. PayHero is asked outside any transaction so a slow reply never holds locks.
 */
export async function settleSubscriptionPrompt(env: Env, sql: postgres.Sql, seller: string, id: string) {
  const found = await withTenant(sql, seller, async (tx) => {
    const [pay] = await tx`SELECT * FROM subscription_payments WHERE id = ${id} AND seller_business_id = ${seller} AND status = 'PENDING'`;
    const [s] = await tx`SELECT * FROM payment_settings`;
    return pay?.provider_ref && s ? { pay, s } : null;
  });
  if (!found) return;
  const { pay, s } = found;
  const outcome = await promptOutcome(env, s, { id: pay.id as string, provider_ref: pay.provider_ref as string });
  if (!outcome) return;
  const { st, amount } = outcome;
  await withTenant(sql, seller, async (tx) => {
    const [still] = await tx`SELECT id FROM subscription_payments WHERE id = ${pay.id} AND status = 'PENDING' FOR UPDATE`;
    if (!still) return; // a concurrent callback already settled it
    if (st.status === "FAILED") {
      await tx`UPDATE subscription_payments SET status = 'FAILED', settled_at = now() WHERE id = ${pay.id}`;
      return;
    }
    if (st.status !== "SUCCESS" || amount === undefined) return;
    if (Math.round(amount * 100) !== Number(pay.amount_cents)) {
      await tx`UPDATE subscription_payments SET status = 'REVIEW', settled_at = now() WHERE id = ${pay.id}`;
      await audit(tx, { businessId: seller, action: "billing.amount_mismatch", entity: "subscription_payment", entityId: pay.id, after: st });
      return;
    }
    const [owner] = await tx`SELECT id FROM users WHERE role = 'OWNER' AND is_active ORDER BY created_at LIMIT 1`;
    const reference = st.provider_reference!.toUpperCase();
    const line = pay.line as { product_id: string; description: string; unit_price_cents: string; tax_code: string; net_cents: string; tax_cents: string; total_cents: string };
    const doc = await createDocument(tx, { bid: seller, sub: owner!.id as string },
      { type: "INVOICE", customerId: pay.customer_id as string, idempotencyKey: `sub-${pay.id}`, lines: [{ productId: line.product_id, quantity: 1 }], payments: [{ method: "MPESA", amountCents: Number(pay.amount_cents), reference }] },
      undefined, [line]);
    const [ext] = await tx`SELECT extend_subscription(${pay.business_id}, ${pay.plan}, ${pay.cycle}) AS paid_until`;
    await tx`UPDATE subscription_payments SET status = 'CONFIRMED', reference = ${reference}, document_id = ${doc.id}, paid_until = ${ext!.paid_until}, settled_at = now() WHERE id = ${pay.id}`;
    await audit(tx, { businessId: seller, action: "billing.payment_confirmed", entity: "subscription_payment", entityId: pay.id, after: { client: pay.business_id, plan: pay.plan, cycle: pay.cycle, reference } });
  });
}

/** Poll target for the Billing page. Also re-checks with PayHero after a short wait, so a lost callback doesn't leave the client staring at a spinner. */
export async function promptStatus(env: Env, sql: postgres.Sql, seller: string, bid: string, id: string) {
  const read = async () => (await withTenant(sql, bid, (tx) => tx`SELECT id, status, plan, cycle, amount_cents, reference, paid_until, created_at FROM subscription_payments WHERE id = ${id} AND business_id = ${bid}`))[0];
  const pay = await read();
  if (!pay) throw new HTTPException(404, { message: "Payment not found" });
  if (pay.status !== "PENDING" || Date.now() - new Date(pay.created_at).getTime() < 20_000) return pay;
  await settleSubscriptionPrompt(env, sql, seller, id);
  return read();
}

const DAY_WORD = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** What the owner should hear today, if anything. Each day number comes round once because the job runs once a day. */
function reminder(kind: string, daysLeft: number, endsOn: string, what: string): { title: string; body: string } | null {
  const pay = "Open Billing in the app to pay by M-Pesa.";
  if ((kind === "TRIAL" || kind === "ACTIVE") && [7, 3, 1].includes(daysLeft)) return { title: `Your ${what} ends in ${DAY_WORD(daysLeft)}`, body: `It ends on ${endsOn}. ${pay}` };
  if (kind === "GRACE") return { title: `Your ${what} has ended`, body: `You have ${DAY_WORD(Math.max(3 + daysLeft, 0))} before the app becomes read-only. ${pay}` };
  if (kind === "LAPSED" && daysLeft === -3) return { title: "Your BiasharaPOS account is now read-only", body: `You can still sign in, see and export your records, but can't make sales or changes until you pay. ${pay}` };
  return null;
}

/** Daily: reminders to owners, plus an automatic M-Pesa prompt from the last day of the period until the grace ends, to the number they saved. Safe to re-run the same day. */
export async function runBillingJob(env: Env, sql: postgres.Sql, opts: { now?: Date; businessIds?: string[]; origin?: string } = {}) {
  const now = opts.now ?? new Date();
  const day = nairobiDate(now);
  const result = { businesses: 0, reminded: 0, prompted: 0, failed: 0 };
  const seller = await sellerBusinessId(env, sql);
  if (!seller) return result;
  const ids = (opts.businessIds ?? (await sql`SELECT id FROM job_business_ids()`).map((r) => r.id as string)).filter((id) => id !== seller);
  for (const bid of ids) {
    result.businesses++;
    try {
      const { row, claimed } = await withTenant(sql, bid, async (tx) => {
        const [b] = await tx`SELECT trial_ends_at, paid_until, plan, next_plan, billing_cycle, billing_phone, last_billing_prompt FROM businesses WHERE id = ${bid}`;
        const state = billingState({ trial_ends_at: b!.trial_ends_at, paid_until: b!.paid_until }, now);
        const note = reminder(state.kind, state.daysLeft, nairobiDate(new Date(state.endsAt)), b!.paid_until ? "BiasharaPOS subscription" : "BiasharaPOS free trial");
        if (note) {
          const [row] = await tx`INSERT INTO notifications (business_id, kind, title, body, data, dedupe_key)
            VALUES (${bid}, 'BILLING', ${note.title}, ${note.body}, ${tx.json({ state: state.kind, days_left: state.daysLeft })}, ${`billing:${day}`})
            ON CONFLICT (business_id, dedupe_key) DO NOTHING RETURNING id`;
          if (row) result.reminded++;
        }
        const due = (state.kind === "GRACE" || (state.kind !== "LAPSED" && state.daysLeft <= 1)) && b!.plan !== "ENTERPRISE";
        // Claimed in the same transaction, so a re-run or overlapping run can't prompt twice in a day.
        const claimed = due && b!.billing_phone && b!.billing_cycle && (b!.next_plan ?? b!.plan)
          ? (await tx`UPDATE businesses SET last_billing_prompt = ${day} WHERE id = ${bid} AND last_billing_prompt IS DISTINCT FROM ${day} RETURNING id`).length > 0
          : false;
        return { row: b!, claimed };
      });
      if (claimed) {
        await startPrompt(env, sql, seller, bid, { plan: (row.next_plan ?? row.plan) as SelfServePlan, cycle: row.billing_cycle as BillingCycle, phone: row.billing_phone as string }, opts.origin ?? env.APP_ORIGIN, "AUTO");
        result.prompted++;
      }
      await emailPending(env, sql, bid);
    } catch (err) {
      result.failed++;
      console.error(`billing job failed for business ${bid}`, err);
    }
  }
  return result;
}
