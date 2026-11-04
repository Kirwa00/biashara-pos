import { billingChoiceSchema, billingState } from "@kpos/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sellerBusinessId } from "../access";
import { requireAuth, requirePermission } from "../auth";
import { assertPlanFits, planPrices, promptStatus, saveChoice, startPrompt } from "../billing";
import { audit, withTenant } from "../db";
import type { AppEnv } from "../env";

const sellerFor = async (c: { env: AppEnv["Bindings"]; get: (k: "sql") => AppEnv["Variables"]["sql"] }, bid: string) => {
  const seller = await sellerBusinessId(c.env, c.get("sql"));
  if (!seller || seller === bid) throw new HTTPException(409, { message: "This business isn't billed" });
  return seller;
};

/** A business paying BiasharaPOS for its own subscription. Owners only; open even when lapsed, or they could never pay. */
export const billingRoutes = new Hono<AppEnv>()
  .use("/billing", requireAuth, requirePermission("billing.manage"))
  .use("/billing/*", requireAuth, requirePermission("billing.manage"))
  .get("/billing", async (c) => {
    const { bid } = c.get("auth");
    const sql = c.get("sql");
    const seller = await sellerBusinessId(c.env, sql);
    if (!seller || seller === bid) return c.json({ billed: false });
    const { b, payments } = await withTenant(sql, bid, async (tx) => ({
      b: (await tx`SELECT trial_ends_at, paid_until, plan, next_plan, billing_cycle, billing_phone FROM businesses WHERE id = ${bid}`)[0]!,
      payments: await tx`SELECT id, plan, cycle, amount_cents, status, reference, paid_until, source, created_at FROM subscription_payments WHERE business_id = ${bid} AND status <> 'FAILED' ORDER BY created_at DESC LIMIT 24`,
    }));
    return c.json({ billed: true, state: billingState({ trial_ends_at: b.trial_ends_at, paid_until: b.paid_until }), trialEndsAt: b.trial_ends_at, paidUntil: b.paid_until,
      plan: b.plan, nextPlan: b.next_plan ?? b.plan, cycle: b.billing_cycle, phone: b.billing_phone, prices: await planPrices(sql, seller), payments });
  })
  /** Saves the plan and number for the automatic prompt, without charging now. */
  .put("/billing/plan", zValidator("json", billingChoiceSchema), async (c) => {
    const { bid, sub } = c.get("auth");
    const sql = c.get("sql");
    await sellerFor(c, bid);
    const body = c.req.valid("json");
    await assertPlanFits(sql, bid, body.plan);
    await saveChoice(sql, bid, body);
    await withTenant(sql, bid, (tx) => audit(tx, { businessId: bid, userId: sub, action: "billing.plan_saved", entity: "business", entityId: bid, after: { plan: body.plan, cycle: body.cycle } }));
    return c.json({ saved: true });
  })
  .post("/billing/pay", zValidator("json", billingChoiceSchema), async (c) => {
    const { bid } = c.get("auth");
    const seller = await sellerFor(c, bid);
    return c.json(await startPrompt(c.env, c.get("sql"), seller, bid, c.req.valid("json"), new URL(c.req.url).origin, "OWNER"), 202);
  })
  .get("/billing/payments/:id", async (c) => {
    const { bid } = c.get("auth");
    if (!/^[0-9a-f-]{36}$/i.test(c.req.param("id"))) throw new HTTPException(404, { message: "Payment not found" });
    const seller = await sellerFor(c, bid);
    return c.json(await promptStatus(c.env, c.get("sql"), seller, bid, c.req.param("id")));
  });
