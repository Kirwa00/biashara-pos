import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { createSql } from "./db";
import type { AppEnv } from "./env";
import { authRoutes } from "./routes/auth";
import { businessRoutes } from "./routes/business";
import { catalogRoutes } from "./routes/catalog";
import { customerRoutes } from "./routes/customers";
import { documentRoutes } from "./routes/documents";
import { paymentRoutes, webhookRoutes } from "./routes/payments";
import { reportRoutes } from "./routes/reports";
import { exportRoutes } from "./routes/export";
import { shiftRoutes } from "./routes/shifts";
import { stockRoutes } from "./routes/stock";
import { supplierRoutes } from "./routes/suppliers";

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
  .route("/v1/webhooks", webhookRoutes)
  .route("/v1", businessRoutes)
  .route("/v1", catalogRoutes)
  .route("/v1", customerRoutes)
  .route("/v1", stockRoutes)
  .route("/v1", documentRoutes)
  .route("/v1", supplierRoutes)
  .route("/v1", paymentRoutes)
  .route("/v1", reportRoutes)
  .route("/v1", shiftRoutes)
  .route("/v1", exportRoutes);

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  const code = (err as { code?: string }).code;
  if (code === "23505") return c.json({ error: "Already exists" }, 409);
  if (code === "23503") return c.json({ error: "Invalid reference" }, 400);
  console.error(err);
  return c.json({ error: "Something went wrong" }, 500);
});

export type AppType = typeof app;
