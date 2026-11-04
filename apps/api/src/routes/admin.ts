import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type postgres from "postgres";
import { requireAuth, signAccess } from "../auth";
import { audit, withTenant } from "../db";
import type { AppEnv, Env } from "../env";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const adminEmails = (env: Env) => new Set((env.SUPER_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));

/** True when the signed-in user's email is listed in SUPER_ADMIN_EMAILS (never during a support session). */
export async function isSuperAdmin(env: Env, sql: postgres.Sql, auth: { sub: string; bid: string; imp?: string }) {
  const list = adminEmails(env);
  if (!list.size || auth.imp) return false;
  const [u] = await withTenant(sql, auth.bid, (tx) => tx`SELECT email FROM users WHERE id = ${auth.sub} AND is_active`);
  return !!u && list.has(String(u.email).toLowerCase());
}

const requireSuperAdmin = createMiddleware<AppEnv & { Variables: { adminEmail: string } }>(async (c, next) => {
  const auth = c.get("auth");
  if (!(await isSuperAdmin(c.env, c.get("sql"), auth))) throw new HTTPException(403, { message: "Not allowed" });
  const [u] = await withTenant(c.get("sql"), auth.bid, (tx) => tx`SELECT email FROM users WHERE id = ${auth.sub}`);
  c.set("adminEmail", u!.email);
  await next();
});

/** Records an admin action on the platform log and in the affected business's own audit trail. */
async function logAction(sql: postgres.Sql, admin: { id: string; email: string }, bid: string, action: string, detail: Record<string, unknown> = {}) {
  await sql`INSERT INTO admin_actions (admin_user_id, admin_email, action, business_id, detail) VALUES (${admin.id}, ${admin.email}, ${action}, ${bid}, ${sql.json(detail as never)})`;
  await withTenant(sql, bid, (tx) => audit(tx, { businessId: bid, action: `admin.${action}`, entity: "business", entityId: bid, after: { by: admin.email, ...detail } }));
}

async function targetBusiness(sql: postgres.Sql, id: string) {
  if (!UUID.test(id)) throw new HTTPException(404, { message: "Business not found" });
  const [b] = await withTenant(sql, id, (tx) => tx`SELECT id, name, status FROM businesses WHERE id = ${id}`);
  if (!b) throw new HTTPException(404, { message: "Business not found" });
  return b;
}

/** Platform console: every tenant at a glance, suspend/reactivate, and read-only "view as owner" for support. */
export const adminRoutes = new Hono<AppEnv & { Variables: { adminEmail: string } }>()
  .use("/admin/*", requireAuth, requireSuperAdmin)
  .get("/admin/businesses", async (c) => c.json(await c.get("sql")`SELECT * FROM admin_businesses() LIMIT 1000`))
  .get("/admin/actions", async (c) =>
    c.json(await c.get("sql")`SELECT a.*, b.name AS business_name FROM admin_actions a LEFT JOIN admin_businesses() b ON b.id = a.business_id ORDER BY a.created_at DESC LIMIT 200`))
  .post("/admin/businesses/:id/suspend", async (c) => {
    const sql = c.get("sql");
    const b = await targetBusiness(sql, c.req.param("id"));
    if (b.id === c.get("auth").bid) throw new HTTPException(409, { message: "You cannot suspend your own business" });
    if (b.status === "SUSPENDED") throw new HTTPException(409, { message: "Already suspended" });
    // Sign-in and token refresh refuse suspended businesses; revoking refresh tokens ends sessions within 15 minutes.
    await withTenant(sql, b.id, async (tx) => {
      await tx`UPDATE businesses SET status = 'SUSPENDED' WHERE id = ${b.id}`;
      await tx`UPDATE refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL`;
    });
    await logAction(sql, { id: c.get("auth").sub, email: c.get("adminEmail") }, b.id, "suspend", { from: b.status });
    return c.json({ id: b.id, status: "SUSPENDED" });
  })
  .post("/admin/businesses/:id/reactivate", async (c) => {
    const sql = c.get("sql");
    const b = await targetBusiness(sql, c.req.param("id"));
    if (b.status !== "SUSPENDED") throw new HTTPException(409, { message: "Business is not suspended" });
    await withTenant(sql, b.id, (tx) => tx`UPDATE businesses SET status = 'ACTIVE' WHERE id = ${b.id}`);
    await logAction(sql, { id: c.get("auth").sub, email: c.get("adminEmail") }, b.id, "reactivate");
    return c.json({ id: b.id, status: "ACTIVE" });
  })
  /** A 15-minute, read-only access token as the business owner. No refresh token, so it simply ends. */
  .post("/admin/businesses/:id/impersonate", async (c) => {
    const sql = c.get("sql");
    const b = await targetBusiness(sql, c.req.param("id"));
    const [owner] = await withTenant(sql, b.id, (tx) => tx`SELECT id, name FROM users WHERE role = 'OWNER' AND is_active ORDER BY created_at LIMIT 1`);
    if (!owner) throw new HTTPException(409, { message: "This business has no active owner" });
    await logAction(sql, { id: c.get("auth").sub, email: c.get("adminEmail") }, b.id, "impersonate", { as: owner.id });
    return c.json({ accessToken: await signAccess(c.env.JWT_SECRET, { id: owner.id, businessId: b.id, role: "OWNER" }, c.get("auth").sub), business: b.name, readOnly: true });
  });
