import { createBranchSchema, createUserSchema } from "@kpos/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth, requirePermission } from "../auth";
import { hashPassword } from "../crypto";
import { audit, withTenant } from "../db";
import type { AppEnv } from "../env";

export const businessRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/me", async (c) => {
    const { sub, bid } = c.get("auth");
    return withTenant(c.get("sql"), bid, async (tx) => {
      const [user] = await tx`SELECT id, name, email, role, branch_id FROM users WHERE id = ${sub}`;
      const [business] = await tx`SELECT id, name, kra_pin, currency, timezone, status FROM businesses WHERE id = ${bid}`;
      return c.json({ user, business });
    });
  })
  .get("/branches", async (c) =>
    c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`SELECT id, name, code, is_active FROM branches ORDER BY created_at`)),
  )
  .post("/branches", requirePermission("branches.manage"), zValidator("json", createBranchSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const body = c.req.valid("json");
    const branch = await withTenant(c.get("sql"), bid, async (tx) => {
      const [b] = await tx`INSERT INTO branches (business_id, name, code) VALUES (${bid}, ${body.name}, ${body.code.toUpperCase()}) RETURNING id, name, code`;
      await audit(tx, { businessId: bid, userId: sub, action: "branch.create", entity: "branch", entityId: b!.id, after: b });
      return b;
    });
    return c.json(branch, 201);
  })
  .get("/users", requirePermission("users.manage"), async (c) =>
    c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) => tx`SELECT id, name, email, role, branch_id, is_active FROM users ORDER BY created_at`)),
  )
  .post("/users", requirePermission("users.manage"), zValidator("json", createUserSchema), async (c) => {
    const { sub, bid } = c.get("auth");
    const body = c.req.valid("json");
    const sql = c.get("sql");
    const [taken] = await sql`SELECT 1 FROM auth_lookup(${body.email})`;
    if (taken) throw new HTTPException(409, { message: "Email already registered" });
    const [passwordHash, pinHash] = await Promise.all([hashPassword(body.password), body.pin ? hashPassword(body.pin) : null]);
    const user = await withTenant(sql, bid, async (tx) => {
      const [u] = await tx`INSERT INTO users (business_id, branch_id, name, email, password_hash, pin_hash, role)
        VALUES (${bid}, ${body.branchId ?? null}, ${body.name}, ${body.email}, ${passwordHash}, ${pinHash}, ${body.role}) RETURNING id, name, email, role`;
      await audit(tx, { businessId: bid, userId: sub, action: "user.create", entity: "user", entityId: u!.id, after: u });
      return u;
    });
    return c.json(user, 201);
  })
  .get("/audit", requirePermission("audit.view"), async (c) =>
    c.json(await withTenant(c.get("sql"), c.get("auth").bid, (tx) =>
      tx`SELECT id, user_id, action, entity, entity_id, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 100`)),
  );
