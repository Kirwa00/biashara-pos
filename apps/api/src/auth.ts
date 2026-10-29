import { can, type Permission, type Role } from "@kpos/shared";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { sign, verify } from "hono/jwt";
import type { AppEnv, AuthClaims } from "./env";

export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_S = 30 * 24 * 3600;

export function signAccess(secret: string, user: { id: string; businessId: string; role: Role }) {
  const claims: AuthClaims = { sub: user.id, bid: user.businessId, role: user.role, exp: Math.floor(Date.now() / 1000) + ACCESS_TTL_S };
  return sign({ ...claims }, secret, "HS256");
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) throw new HTTPException(401, { message: "Not signed in" });
  try {
    c.set("auth", (await verify(header.slice(7), c.env.JWT_SECRET, "HS256")) as unknown as AuthClaims);
  } catch {
    throw new HTTPException(401, { message: "Session expired" });
  }
  await next();
});

export const requirePermission = (permission: Permission) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!can(c.get("auth").role, permission)) throw new HTTPException(403, { message: "Not allowed" });
    await next();
  });
