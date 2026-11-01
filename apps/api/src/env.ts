import type { Role } from "@kpos/shared";
import type postgres from "postgres";

/** Workers Rate Limiting binding (wrangler.toml [[ratelimits]]). */
export interface Limiter { limit(o: { key: string }): Promise<{ success: boolean }> }

export interface Env {
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
  JWT_SECRET: string;
  APP_ORIGIN: string;
  ENCRYPTION_KEY?: string;
  PAYHERO_BASE_URL?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  ETIMS_BASE_URL?: string;
  /** Comma-separated emails of platform admins. Register these accounts before setting it. */
  SUPER_ADMIN_EMAILS?: string;
  AUTH_LIMITER?: Limiter;
  API_LIMITER?: Limiter;
}

export interface AuthClaims {
  sub: string;
  bid: string;
  role: Role;
  exp: number;
  /** Set on a read-only support session: the platform admin's user id. */
  imp?: string;
}

export type AppEnv = { Bindings: Env; Variables: { sql: postgres.Sql; auth: AuthClaims } };
