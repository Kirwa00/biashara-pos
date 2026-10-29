import { loginSchema, registerSchema, type Role } from "@kpos/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth, signAccess, REFRESH_TTL_S } from "../auth";
import { hashPassword, randomToken, sha256, verifyPassword } from "../crypto";
import { audit, withTenant } from "../db";
import type { AppEnv } from "../env";
import type postgres from "postgres";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

async function issueTokens(tx: postgres.TransactionSql, secret: string, user: { id: string; businessId: string; role: Role }) {
  const refreshToken = randomToken();
  await tx`INSERT INTO refresh_tokens (business_id, user_id, token_hash, expires_at)
    VALUES (${user.businessId}, ${user.id}, ${await sha256(refreshToken)}, now() + ${REFRESH_TTL_S + " seconds"}::interval)`;
  return { accessToken: await signAccess(secret, user), refreshToken };
}

export const authRoutes = new Hono<AppEnv>()
  .post("/register", zValidator("json", registerSchema), async (c) => {
    const body = c.req.valid("json");
    const sql = c.get("sql");
    const [taken] = await sql`SELECT 1 FROM auth_lookup(${body.email})`;
    if (taken) throw new HTTPException(409, { message: "Email already registered" });
    const businessId = crypto.randomUUID();
    const passwordHash = await hashPassword(body.password);
    const result = await withTenant(sql, businessId, async (tx) => {
      await tx`INSERT INTO businesses (id, name, kra_pin, phone) VALUES (${businessId}, ${body.businessName}, ${body.kraPin ?? null}, ${body.phone})`;
      const [branch] = await tx`INSERT INTO branches (business_id, name, code) VALUES (${businessId}, 'Main Branch', 'MAIN') RETURNING id`;
      const [user] = await tx`INSERT INTO users (business_id, branch_id, name, email, password_hash, role)
        VALUES (${businessId}, ${branch!.id}, ${body.ownerName}, ${body.email}, ${passwordHash}, 'OWNER') RETURNING id`;
      await audit(tx, { businessId, userId: user!.id, action: "business.register", entity: "business", entityId: businessId, after: { name: body.businessName } });
      return issueTokens(tx, c.env.JWT_SECRET, { id: user!.id, businessId, role: "OWNER" });
    });
    return c.json(result, 201);
  })
  .post("/login", zValidator("json", loginSchema), async (c) => {
    const { email, password } = c.req.valid("json");
    const sql = c.get("sql");
    const [u] = await sql`SELECT * FROM auth_lookup(${email})`;
    const ok = u ? await verifyPassword(password, u.password_hash) : await verifyPassword(password, "pbkdf2$1$AA==$AA==");
    if (!u || !u.is_active) throw new HTTPException(401, { message: "Wrong email or password" });
    if (u.locked_until && new Date(u.locked_until) > new Date()) throw new HTTPException(423, { message: "Account locked. Try again later." });
    if (!ok) {
      await withTenant(sql, u.business_id, async (tx) => {
        await tx`UPDATE users SET failed_logins = failed_logins + 1,
          locked_until = CASE WHEN failed_logins + 1 >= ${MAX_FAILED} THEN now() + ${LOCK_MINUTES + " minutes"}::interval END WHERE id = ${u.id}`;
        await audit(tx, { businessId: u.business_id, userId: u.id, action: "auth.login_failed", entity: "user", entityId: u.id, ip: c.req.header("cf-connecting-ip") });
      });
      throw new HTTPException(401, { message: "Wrong email or password" });
    }
    return withTenant(sql, u.business_id, async (tx) => {
      await tx`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ${u.id}`;
      await audit(tx, { businessId: u.business_id, userId: u.id, action: "auth.login", entity: "user", entityId: u.id, ip: c.req.header("cf-connecting-ip") });
      return c.json(await issueTokens(tx, c.env.JWT_SECRET, { id: u.id, businessId: u.business_id, role: u.role }));
    });
  })
  .post("/refresh", async (c) => {
    const { refreshToken } = await c.req.json<{ refreshToken?: string }>();
    if (!refreshToken) throw new HTTPException(400, { message: "refreshToken required" });
    const sql = c.get("sql");
    const [t] = await sql`SELECT * FROM refresh_lookup(${await sha256(refreshToken)})`;
    if (!t) throw new HTTPException(401, { message: "Session expired" });
    return withTenant(sql, t.business_id, async (tx) => {
      await tx`UPDATE refresh_tokens SET revoked_at = now() WHERE id = ${t.id}`;
      const [u] = await tx`SELECT id, role, is_active FROM users WHERE id = ${t.user_id}`;
      if (!u?.is_active) throw new HTTPException(401, { message: "Session expired" });
      return c.json(await issueTokens(tx, c.env.JWT_SECRET, { id: u.id, businessId: t.business_id, role: u.role }));
    });
  })
  .post("/logout", requireAuth, async (c) => {
    const { sub, bid } = c.get("auth");
    await withTenant(c.get("sql"), bid, (tx) => tx`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = ${sub} AND revoked_at IS NULL`);
    return c.body(null, 204);
  });
