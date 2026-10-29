import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { createSql } from "./db";
import type { AppEnv } from "./env";
import { authRoutes } from "./routes/auth";
import { businessRoutes } from "./routes/business";

export const app = new Hono<AppEnv>()
  .use(secureHeaders())
  .use("*", (c, next) => cors({ origin: c.env.APP_ORIGIN, credentials: true })(c, next))
  .get("/health", (c) => c.json({ ok: true }))
  .use("/v1/*", async (c, next) => {
    const sql = createSql(c.env);
    c.set("sql", sql);
    try {
      await next();
    } finally {
      const done = sql.end({ timeout: 5 });
      try {
        c.executionCtx.waitUntil(done);
      } catch {
        await done;
      }
    }
  })
  .route("/v1/auth", authRoutes)
  .route("/v1", businessRoutes);

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  if ((err as { code?: string }).code === "23505") return c.json({ error: "Already exists" }, 409);
  console.error(err);
  return c.json({ error: "Something went wrong" }, 500);
});

export type AppType = typeof app;
