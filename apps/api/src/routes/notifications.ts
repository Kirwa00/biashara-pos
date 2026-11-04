import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAuth, requirePermission } from "../auth";
import { audit, withTenant } from "../db";
import type { AppEnv } from "../env";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Notification centre: alerts written by the scheduled jobs, read state shared across the business. */
export const notificationRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/notifications", requirePermission("reports.view"), async (c) => {
    const unreadOnly = c.req.query("unread") === "1";
    return c.json(await withTenant(c.get("sql"), c.get("auth").bid, async (tx) => ({
      unread: (await tx`SELECT count(*)::int AS n FROM notifications WHERE read_at IS NULL`)[0]!.n,
      items: await tx`SELECT id, kind, title, body, data, email_status, read_at, created_at FROM notifications
        ${unreadOnly ? tx`WHERE read_at IS NULL` : tx``} ORDER BY created_at DESC, kind LIMIT 100`,
    })));
  })
  .post("/notifications/read-all", requirePermission("reports.view"), async (c) => {
    const { sub, bid } = c.get("auth");
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const rows = await tx`UPDATE notifications SET read_at = now() WHERE read_at IS NULL RETURNING id`;
      if (rows.length) await audit(tx, { businessId: bid, userId: sub, action: "notification.read_all", entity: "notification", after: { count: rows.length } });
      return { updated: rows.length };
    }));
  })
  .post("/notifications/:id/read", requirePermission("reports.view"), async (c) => {
    const { sub, bid } = c.get("auth");
    const id = c.req.param("id");
    if (!UUID.test(id)) throw new HTTPException(404, { message: "Notification not found" });
    return c.json(await withTenant(c.get("sql"), bid, async (tx) => {
      const [n] = await tx`UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE id = ${id} RETURNING id, read_at`;
      if (!n) throw new HTTPException(404, { message: "Notification not found" });
      await audit(tx, { businessId: bid, userId: sub, action: "notification.read", entity: "notification", entityId: id });
      return n;
    }));
  });
