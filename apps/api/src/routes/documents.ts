import { can, computeLine, documentSchema, paymentInputSchema, returnSchema, unitPrice, type TaxCode } from "@kpos/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type postgres from "postgres";
import type { z } from "zod";
import { requireAuth, requirePermission } from "../auth";
import { audit, withTenant } from "../db";
import type { AppEnv } from "../env";
import { currentShiftId } from "./shifts";
import { postMovement, resolveBranch } from "./stock";

type Tx = postgres.TransactionSql;
type DocInput = z.infer<typeof documentSchema>;
type Ctx = { bid: string; sub: string };

export async function nextNumber(tx: Tx, bid: string, type: string): Promise<number> {
  const [r] = await tx`INSERT INTO doc_counters (business_id, type, last_number) VALUES (${bid}, ${type}, 1)
    ON CONFLICT (business_id, type) DO UPDATE SET last_number = doc_counters.last_number + 1 RETURNING last_number`;
  return r!.last_number as number;
}

const statusFor = (type: string, total: number, paid: number) =>
  type === "QUOTE" ? "OPEN" : paid >= total ? "PAID" : paid > 0 ? "PARTIAL" : "UNPAID";

/** Adds a confirmed payment to a document, rejecting overpayment. Caller must hold the document row lock. */
export async function applyPayment(tx: Tx, doc: postgres.Row, amountCents: number) {
  const balance = Number(doc.total_cents) - Number(doc.paid_cents);
  if (amountCents > balance) throw new HTTPException(422, { message: `Payment exceeds balance of ${balance} cents` });
  const paid = Number(doc.paid_cents) + amountCents;
  await tx`UPDATE documents SET paid_cents = ${paid}, status = ${statusFor(doc.type, Number(doc.total_cents), paid)} WHERE id = ${doc.id}`;
}

type Fixed = { description: string; unit_price_cents: string; tax_code: string; net_cents: string; tax_cents: string; total_cents: string };

/** `fixed` carries saved quotation lines so a converted invoice keeps the quoted prices. */
export async function createDocument(tx: Tx, ctx: Ctx, body: DocInput, sourceId?: string, fixed?: Fixed[]) {
  if (body.idempotencyKey) {
    const [dup] = await tx`SELECT * FROM documents WHERE idempotency_key = ${body.idempotencyKey}`;
    if (dup) return dup;
  }
  if (body.type === "QUOTE" && body.payments.length) throw new HTTPException(422, { message: "Quotations cannot take payments" });
  if (body.type === "INVOICE" && !body.customerId) throw new HTTPException(422, { message: "Invoices need a customer" });
  const branchId = await resolveBranch(tx, ctx.sub, body.branchId);
  const [cust] = body.customerId ? await tx`SELECT * FROM customers WHERE id = ${body.customerId} AND is_active FOR UPDATE` : [];
  if (body.customerId && !cust) throw new HTTPException(400, { message: "Unknown customer" });

  const ids = [...new Set(body.lines.map((l) => l.productId))];
  const products = new Map((await tx`SELECT * FROM products WHERE ${fixed ? tx`true` : tx`is_active`} AND id IN ${tx(ids)}`).map((p) => [p.id as string, p]));
  const lines = body.lines.map((l, i) => {
    const p = products.get(l.productId);
    if (!p) throw new HTTPException(400, { message: `Unknown product ${l.productId}` });
    const f = fixed?.[i];
    if (f) return { ...l, p: { ...p, name: f.description, tax_code: f.tax_code } as typeof p, price: Number(f.unit_price_cents), t: { netCents: Number(f.net_cents), taxCents: Number(f.tax_cents), totalCents: Number(f.total_cents) } };
    const price = unitPrice({ retailPriceCents: Number(p.retail_price_cents), wholesalePriceCents: p.wholesale_price_cents == null ? null : Number(p.wholesale_price_cents), wholesaleMinQty: p.wholesale_min_qty == null ? null : Number(p.wholesale_min_qty) },
      l.quantity, cust?.price_tier ?? "RETAIL");
    return { ...l, p, price, t: computeLine({ unitPriceCents: price, quantity: l.quantity, taxCode: p.tax_code as TaxCode, priceIncludesTax: p.price_includes_tax }) };
  });
  const total = lines.reduce((s, l) => s + l.t.totalCents, 0);
  const paid = body.payments.reduce((s, p) => s + p.amountCents, 0);
  if (paid > total) throw new HTTPException(422, { message: "Payments exceed the total" });
  if (body.type === "SALE" && !cust && paid < total) throw new HTTPException(422, { message: "Walk-in sales must be paid in full" });
  if (cust && body.type !== "QUOTE" && paid < total) {
    const [o] = await tx`SELECT coalesce(sum(total_cents - paid_cents), 0) AS owed FROM documents WHERE customer_id = ${cust.id} AND status IN ('UNPAID','PARTIAL')`;
    if (Number(o!.owed) + total - paid > Number(cust.credit_limit_cents)) throw new HTTPException(409, { message: "Credit limit exceeded" });
  }

  const number = await nextNumber(tx, ctx.bid, body.type);
  const dueDays = body.dueDays ?? cust?.payment_terms_days ?? 0;
  const [doc] = await tx`INSERT INTO documents (business_id, branch_id, type, number, customer_id, status, due_date, net_cents, tax_cents, total_cents, paid_cents, source_id, idempotency_key, created_by)
    VALUES (${ctx.bid}, ${branchId}, ${body.type}, ${number}, ${cust?.id ?? null}, ${statusFor(body.type, total, paid)},
      ${body.type === "QUOTE" ? null : tx`(now() AT TIME ZONE 'Africa/Nairobi')::date + ${dueDays}::int`},
      ${lines.reduce((s, l) => s + l.t.netCents, 0)}, ${lines.reduce((s, l) => s + l.t.taxCents, 0)}, ${total}, ${paid},
      ${sourceId ?? null}, ${body.idempotencyKey ?? null}, ${ctx.sub}) RETURNING *`;
  for (const l of lines) {
    let cost = Number(l.p.cost_cents);
    if (body.type !== "QUOTE" && l.p.track_stock) {
      const r = await postMovement(tx, { businessId: ctx.bid, branchId, productId: l.productId, type: "SALE", quantity: -l.quantity, refType: "document", refId: doc!.id, userId: ctx.sub });
      cost = r.avgCostCents || cost;
    }
    await tx`INSERT INTO document_lines (business_id, document_id, product_id, description, quantity, unit_price_cents, tax_code, net_cents, tax_cents, total_cents, unit_cost_cents)
      VALUES (${ctx.bid}, ${doc!.id}, ${l.productId}, ${l.p.name}, ${l.quantity}, ${l.price}, ${l.p.tax_code}, ${l.t.netCents}, ${l.t.taxCents}, ${l.t.totalCents}, ${cost})`;
  }
  for (const p of body.payments)
    await tx`INSERT INTO payments (business_id, document_id, method, amount_cents, reference, created_by, shift_id) VALUES (${ctx.bid}, ${doc!.id}, ${p.method}, ${p.amountCents}, ${p.reference ?? null}, ${ctx.sub}, ${currentShiftId(tx, ctx.sub)})`;
  await audit(tx, { businessId: ctx.bid, userId: ctx.sub, action: `document.create`, entity: body.type.toLowerCase(), entityId: doc!.id, after: { number, total, paid } });
  return doc!;
}

const canCreate = (type: string) => (type === "SALE" ? "sales.create" : "invoices.manage") as "sales.create" | "invoices.manage";

export const documentRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/documents", async (c) => {
    const type = c.req.query("type");
    const status = c.req.query("status");
    return c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`
      SELECT d.*, cu.name AS customer_name FROM documents d LEFT JOIN customers cu ON cu.id = d.customer_id
      WHERE true ${type ? tx`AND d.type = ${type}` : tx``} ${status ? tx`AND d.status = ${status}` : tx``}
      ORDER BY d.created_at DESC LIMIT 200`));
  })
  .get("/documents/:id", async (c) => c.json(await withTenant(c.get("sql"), c.get("auth").bid, async (tx) => {
    const [doc] = await tx`SELECT d.*, cu.name AS customer_name, cu.kra_pin AS customer_kra_pin FROM documents d LEFT JOIN customers cu ON cu.id = d.customer_id WHERE d.id = ${c.req.param("id")}`;
    if (!doc) throw new HTTPException(404, { message: "Document not found" });
    return { ...doc, lines: await tx`SELECT * FROM document_lines WHERE document_id = ${doc.id} ORDER BY id`, payments: await tx`SELECT * FROM payments WHERE document_id = ${doc.id} ORDER BY created_at` };
  })))
  .post("/documents", zValidator("json", documentSchema), async (c) => {
    const { sub, bid, role } = c.get("auth");
    const body = c.req.valid("json");
    if (!can(role, canCreate(body.type))) throw new HTTPException(403, { message: "Not allowed" });
    return c.json(await withTenant(c.get("sql"), bid, (tx) => createDocument(tx, { bid, sub }, body)), 201);
  })
  .post("/documents/:id/convert", requirePermission("invoices.manage"), async (c) => {
    const { sub, bid } = c.get("auth");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const [q] = await tx`SELECT * FROM documents WHERE id = ${c.req.param("id")} AND type = 'QUOTE' FOR UPDATE`;
      if (!q) throw new HTTPException(404, { message: "Quotation not found" });
      if (q.status !== "OPEN") throw new HTTPException(409, { message: "Quotation already converted" });
      const lines = await tx`SELECT product_id, quantity, description, unit_price_cents, tax_code, net_cents, tax_cents, total_cents FROM document_lines WHERE document_id = ${q.id} ORDER BY id`;
      const inv = await createDocument(tx, { bid, sub }, { type: "INVOICE", branchId: q.branch_id, customerId: q.customer_id ?? undefined, lines: lines.map((l) => ({ productId: l.product_id, quantity: Number(l.quantity) })), payments: [] }, q.id, lines as unknown as Fixed[]);
      await tx`UPDATE documents SET status = 'CONVERTED' WHERE id = ${q.id}`;
      return inv;
    }), 201);
  })
  .post("/documents/:id/return", requirePermission("sales.refund"), zValidator("json", returnSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const b = c.req.valid("json");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const [src] = await tx`SELECT * FROM documents WHERE id = ${c.req.param("id")} AND type IN ('SALE','INVOICE') FOR UPDATE`;
      if (!src) throw new HTTPException(404, { message: "Sale or invoice not found" });
      if (src.status !== "PAID") throw new HTTPException(409, { message: "Only fully paid documents can be refunded in this prototype" });
      const srcLines = await tx`SELECT l.*, p.track_stock,
          l.quantity - coalesce((SELECT sum(r.quantity) FROM document_lines r WHERE r.source_line_id = l.id), 0) AS returnable,
          l.net_cents - coalesce((SELECT sum(r.net_cents) FROM document_lines r WHERE r.source_line_id = l.id), 0) AS net_left,
          l.tax_cents - coalesce((SELECT sum(r.tax_cents) FROM document_lines r WHERE r.source_line_id = l.id), 0) AS tax_left
        FROM document_lines l JOIN products p ON p.id = l.product_id WHERE l.document_id = ${src.id} ORDER BY l.id`;
      const wanted = b.lines ?? srcLines.filter((l) => Number(l.returnable) > 0).map((l) => ({ productId: l.product_id as string, quantity: Number(l.returnable) }));
      if (!wanted.length) throw new HTTPException(409, { message: "Everything on this document has already been returned" });
      const picked = wanted.map((w) => {
        const l = srcLines.find((x) => x.product_id === w.productId && Number(x.returnable) >= w.quantity);
        if (!l) throw new HTTPException(409, { message: `Cannot return ${w.quantity} of product ${w.productId}` });
        const last = Number(l.returnable) === w.quantity;
        l.returnable = Number(l.returnable) - w.quantity;
        const f = w.quantity / Number(l.quantity);
        // Never refund more than is left on the line; the final return takes the exact residual.
        const net = last ? Number(l.net_left) : Math.min(Math.round(Number(l.net_cents) * f), Number(l.net_left));
        const tax = last ? Number(l.tax_left) : Math.min(Math.round(Number(l.tax_cents) * f), Number(l.tax_left));
        l.net_left = Number(l.net_left) - net;
        l.tax_left = Number(l.tax_left) - tax;
        return { l, quantity: w.quantity, net, tax, total: net + tax };
      });
      const total = picked.reduce((s, p) => s + p.total, 0);
      const number = await nextNumber(tx, bid, "CREDIT_NOTE");
      const [cn] = await tx`INSERT INTO documents (business_id, branch_id, type, number, customer_id, status, net_cents, tax_cents, total_cents, paid_cents, source_id, created_by)
        VALUES (${bid}, ${src.branch_id}, 'CREDIT_NOTE', ${number}, ${src.customer_id}, 'REFUNDED', ${picked.reduce((s, p) => s + p.net, 0)},
          ${picked.reduce((s, p) => s + p.tax, 0)}, ${total}, ${total}, ${src.id}, ${sub}) RETURNING *`;
      for (const p of picked) {
        if (p.l.track_stock)
          await postMovement(tx, { businessId: bid, branchId: src.branch_id, productId: p.l.product_id, type: "RETURN", quantity: p.quantity, unitCostCents: Number(p.l.unit_cost_cents), reason: b.reason, refType: "document", refId: cn!.id, userId: sub });
        await tx`INSERT INTO document_lines (business_id, document_id, product_id, description, quantity, unit_price_cents, tax_code, net_cents, tax_cents, total_cents, unit_cost_cents, source_line_id)
          VALUES (${bid}, ${cn!.id}, ${p.l.product_id}, ${p.l.description}, ${p.quantity}, ${p.l.unit_price_cents}, ${p.l.tax_code}, ${p.net}, ${p.tax}, ${p.total}, ${p.l.unit_cost_cents}, ${p.l.id})`;
      }
      await tx`INSERT INTO payments (business_id, document_id, method, amount_cents, reference, created_by, shift_id, direction)
        VALUES (${bid}, ${cn!.id}, ${b.method}, ${total}, ${b.reference ?? null}, ${sub}, ${currentShiftId(tx, sub)}, -1)`;
      await audit(tx, { businessId: bid, userId: sub, action: "document.return", entity: "credit_note", entityId: cn!.id, after: { source: src.id, total, reason: b.reason } });
      return cn;
    }), 201);
  })
  .post("/documents/:id/payments", requirePermission("payments.record"), zValidator("json", paymentInputSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const p = c.req.valid("json");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const [doc] = await tx`SELECT * FROM documents WHERE id = ${c.req.param("id")} AND type <> 'QUOTE' FOR UPDATE`;
      if (!doc) throw new HTTPException(404, { message: "Invoice not found" });
      await applyPayment(tx, doc, p.amountCents);
      const [pay] = await tx`INSERT INTO payments (business_id, document_id, method, amount_cents, reference, created_by, shift_id) VALUES (${bid}, ${doc.id}, ${p.method}, ${p.amountCents}, ${p.reference ?? null}, ${sub}, ${currentShiftId(tx, sub)}) RETURNING *`;
      await audit(tx, { businessId: bid, userId: sub, action: "payment.record", entity: "payment", entityId: pay!.id, after: p });
      return pay;
    }), 201);
  });
