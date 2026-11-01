import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Env, Limiter } from "./env";

/** Workers Rate Limiting binding, keyed by client IP per scope. Without the binding (local dev, tests) it lets everything through. */
export const rateLimit = (scope: string, pick: (env: Env) => Limiter | undefined) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const limiter = pick(c.env);
    if (limiter && !(await limiter.limit({ key: `${scope}:${c.req.header("cf-connecting-ip") ?? "unknown"}` })).success)
      throw new HTTPException(429, { message: "Too many requests. Wait a minute and try again." });
    await next();
  });
