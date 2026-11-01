import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { withTenant } from "../src/db";
import { OscuAdapter, processEtimsQueue, type EtimsAdapter } from "../src/etims";

const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://kpos_app:app@localhost:5432/kenya_pos",
  JWT_SECRET: "test-secret-test-secret-test-secret",
  APP_ORIGIN: "http://localhost:5173",
  ENCRYPTION_KEY: "test-encryption-key",
};
const run = Date.now();
const sql = postgres(env.DATABASE_URL, { max: 2 });
const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  app.request(`http://api.test${path}`, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } }, env);
const post = (path: string, body: unknown, token: string, method = "POST") => call(path, { method, body: JSON.stringify(body), token });
const json = async <T = Record<string, any>>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const register = async (name: string) => {
  const t = (await json(post("/v1/auth/register", { businessName: name, ownerName: "Owner", email: `${name}-${run}@etims.ke`, phone: "0712345678", password: "correct-horse-1" }, ""))).accessToken as string;
  return { t, bid: (await json(call("/v1/me", { token: t }))).business.id as string };
};
/** Fake KRA: accepts everything with sequential receipt numbers unless told to be down. */
const fakeKra = () => {
  const payloads: Record<string, any>[] = [];
  let down = false;
  const adapter: EtimsAdapter = {
    async saveSales(p) {
      if (down) return { ok: false, retryable: true, error: "KRA eTIMS HTTP 503" };
      payloads.push(p);
      return { ok: true, rcptNo: `R${payloads.length}`, rcptSign: "SIGN", internalData: "DATA" };
    },
  };
  return { adapter, payloads, setDown: (v: boolean) => (down = v) };
};

afterEach(() => vi.unstubAllGlobals());
afterAll(() => sql.end());

describe("eTIMS groundwork", () => {
  it("OSCU adapter sends device headers and classifies KRA responses", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const replies = [
      new Response(JSON.stringify({ resultCd: "000", resultMsg: "ok", data: { curRcptNo: 7, rcptSign: "S", intrlData: "I" } })),
      new Response("busy", { status: 503 }),
      new Response(JSON.stringify({ resultCd: "910", resultMsg: "Invalid item class" })),
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, headers: new Headers(init.headers) }); return replies.shift()!; }));
    const oscu = new OscuAdapter("https://kra.test/etims-api", { tin: "P051234567X", bhfId: "00", cmcKey: "cmc-secret" });
    expect(await oscu.saveSales({ invcNo: 1 })).toEqual({ ok: true, rcptNo: "7", rcptSign: "S", internalData: "I" });
    expect(calls[0]!.url).toBe("https://kra.test/etims-api/trnsSales/saveSales");
    expect([calls[0]!.headers.get("tin"), calls[0]!.headers.get("bhfId"), calls[0]!.headers.get("cmcKey")]).toEqual(["P051234567X", "00", "cmc-secret"]);
    expect(await oscu.saveSales({ invcNo: 2 })).toMatchObject({ ok: false, retryable: true });
    expect(await oscu.saveSales({ invcNo: 3 })).toEqual({ ok: false, retryable: false, error: "KRA 910: Invalid item class" });
  });

  it("records tax apart from revenue, submits through the queue once, and reconciliation flags every seeded mismatch", async () => {
    const { t, bid } = await register("etims");
    expect(await json(call("/v1/settings/etims", { token: t }))).toEqual({ configured: false });
    expect((await post("/v1/settings/etims", { tin: "P051234567X", deviceSerial: "SBX-001", cmcKey: "short" }, t, "PUT")).status).toBe(400);
    expect(await json(post("/v1/settings/etims", { tin: "P051234567X", deviceSerial: "SBX-001", cmcKey: "cmc-key-from-kra", enabled: true }, t, "PUT"))).toEqual({ configured: true, enabled: true });
    const settings = await json(call("/v1/settings/etims", { token: t }));
    expect(settings).toMatchObject({ configured: true, environment: "SANDBOX", bhfId: "00", enabled: true });
    expect(JSON.stringify(settings)).not.toContain("cmc-key-from-kra");

    const milk = await json(post("/v1/products", { sku: "MILK", name: "Milk 500ml", retailPriceCents: 11600, trackStock: false }, t));
    const bread = await json(post("/v1/products", { sku: "BREAD", name: "Bread", retailPriceCents: 6000, trackStock: false, taxCode: "C" }, t));
    expect((await post(`/v1/etims/items/${milk.id}`, { itemCode: "KE1NTXU0000001", itemClassCode: "abc" }, t, "PUT")).status).toBe(400);
    expect(await json(post(`/v1/etims/items/${milk.id}`, { itemCode: "KE1NTXU0000001", itemClassCode: "50202300" }, t, "PUT"))).toMatchObject({ kra_unit_code: "U", kra_pkg_unit_code: "NT" });
    const items = await json<{ id: string; mapped: boolean }[]>(call("/v1/etims/items", { token: t }));
    expect(items.find((i) => i.id === bread.id)?.mapped).toBe(false);

    expect((await post("/v1/shifts/open", { openingFloatCents: 0 }, t)).status).toBe(201);
    const sale = (lines: { productId: string; quantity: number }[], cents: number) => json(post("/v1/documents", { type: "SALE", lines, payments: [{ method: "CASH", amountCents: cents }] }, t));
    const s1 = await sale([{ productId: milk.id, quantity: 2 }], 23200);
    const s2 = await sale([{ productId: milk.id, quantity: 1 }], 11600);
    const s3 = await sale([{ productId: bread.id, quantity: 1 }], 6000);
    const cn = await json(post(`/v1/documents/${s1.id}/return`, { lines: [{ productId: milk.id, quantity: 1 }], reason: "Spoilt" }, t));
    expect(cn.type).toBe("CREDIT_NOTE");

    // Tax ledger: VAT by code, credit notes negative, no revenue mixed in.
    const summary = await json(call("/v1/etims/summary", { token: t }));
    expect(summary.connection.status).toBe("SANDBOX");
    const b = summary.byTaxCode.find((r: any) => r.tax_code === "B");
    expect(b).toMatchObject({ rate_bp: 1600, tax_cents: String(Number(s1.tax_cents) + Number(s2.tax_cents) - Number(cn.tax_cents)) });
    expect(summary.byTaxCode.find((r: any) => r.tax_code === "C")).toMatchObject({ rate_bp: 0, tax_cents: "0", taxable_cents: "6000" });

    const kra = fakeKra();
    expect(await processEtimsQueue(env, sql, { businessIds: [bid], adapter: kra.adapter })).toMatchObject({ submitted: 3, failed: 1 });
    expect(kra.payloads.map((p) => p.rcptTyCd)).toEqual(["S", "S", "R"]);
    const [p1, , pcn] = kra.payloads;
    expect(pcn!.orgInvcNo).toBe(p1!.invcNo);
    expect(p1).toMatchObject({ totAmt: 232, totTaxAmt: Number(s1.tax_cents) / 100, taxblAmtB: 232, taxRtB: 16, pmtTyCd: "01" });
    expect(p1!.itemList[0]).toMatchObject({ itemCd: "KE1NTXU0000001", itemClsCd: "50202300", qty: 2, prc: 116, taxTyCd: "B" });
    let subs = await json<{ id: string; document_id: string; status: string; last_error: string | null }[]>(call("/v1/etims/submissions", { token: t }));
    const sub3 = subs.find((x) => x.document_id === s3.id)!;
    expect(sub3).toMatchObject({ status: "FAILED", last_error: "Map KRA item codes for: Bread" });

    // Idempotent: nothing due, nothing resubmitted.
    expect(await processEtimsQueue(env, sql, { businessIds: [bid], adapter: kra.adapter })).toMatchObject({ submitted: 0, failed: 0 });
    expect(kra.payloads).toHaveLength(3);

    await post(`/v1/etims/items/${bread.id}`, { itemCode: "KE1NTXU0000002", itemClassCode: "50181900" }, t, "PUT");
    expect((await post(`/v1/etims/submissions/${subs.find((x) => x.document_id === s1.id)!.id}/retry`, {}, t)).status).toBe(409);
    expect((await post(`/v1/etims/submissions/${sub3.id}/retry`, {}, t)).status).toBe(200);
    expect(await processEtimsQueue(env, sql, { businessIds: [bid], adapter: kra.adapter })).toMatchObject({ submitted: 1 });

    // KRA outage: the sale queues, fails retryably and backs off.
    const s4 = await sale([{ productId: milk.id, quantity: 1 }], 11600);
    kra.setDown(true);
    expect(await processEtimsQueue(env, sql, { businessIds: [bid], adapter: kra.adapter })).toMatchObject({ failed: 1 });
    subs = await json(call("/v1/etims/submissions?status=FAILED", { token: t }));
    expect(subs.map((x) => x.document_id)).toEqual([s4.id]);
    expect(await processEtimsQueue(env, sql, { businessIds: [bid], adapter: kra.adapter })).toMatchObject({ failed: 0 });

    const clean = await json(call("/v1/etims/reconciliation", { token: t }));
    expect(clean).toMatchObject({ documents: 5, submitted: 4, missing: 1, duplicate: 0, mismatched: 0 });

    // Seed one of each problem: duplicate receipt, KRA amount differs, tax ledger differs.
    await withTenant(sql, bid, async (tx) => {
      await tx`UPDATE etims_submissions SET rcpt_no = (SELECT rcpt_no FROM etims_submissions WHERE document_id = ${s1.id}) WHERE document_id = ${s2.id}`;
      await tx`UPDATE etims_submissions SET kra_total_cents = kra_total_cents + 100 WHERE document_id = ${s3.id}`;
      await tx`INSERT INTO tax_records (business_id, document_id, tax_code, rate_bp, sign, taxable_cents, tax_cents, issue_date)
        SELECT business_id, id, 'E', 800, -1, 625, 50, issue_date FROM documents WHERE id = ${cn.id}`;
    });
    const rec = await json<{ missing: number; duplicate: number; mismatched: number; issues: { type: string; document_id: string; detail: string }[] }>(call("/v1/etims/reconciliation", { token: t }));
    const flagged = (type: string) => rec.issues.filter((i) => i.type === type).map((i) => i.document_id).sort();
    expect(flagged("MISSING")).toEqual([s4.id]);
    expect(flagged("DUPLICATE")).toEqual([s1.id, s2.id].sort());
    expect(flagged("MISMATCHED")).toEqual([s3.id, cn.id].sort());
    expect(rec).toMatchObject({ missing: 1, duplicate: 2, mismatched: 2 });

    const docs = await json<{ id: string; etimsStatus: string; cuInvoiceNumber: string | null }[]>(call("/v1/etims/invoices", { token: t }));
    expect(docs.find((d) => d.id === s3.id)).toMatchObject({ etimsStatus: "SUBMITTED", cuInvoiceNumber: "R4" });

    const other = await register("etims-b");
    expect(await json(call("/v1/etims/reconciliation", { token: other.t }))).toMatchObject({ documents: 0, issues: [] });
    expect((await post(`/v1/etims/submissions/${sub3.id}/retry`, {}, other.t)).status).toBe(404);
    expect(await processEtimsQueue(env, sql, { businessIds: [other.bid], adapter: kra.adapter })).toMatchObject({ businesses: 0 });
  });
});
