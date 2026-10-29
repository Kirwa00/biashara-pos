import type { Role } from "@kpos/shared";
import type postgres from "postgres";

export interface Env {
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
  JWT_SECRET: string;
  APP_ORIGIN: string;
}

export interface AuthClaims {
  sub: string;
  bid: string;
  role: Role;
  exp: number;
}

export type AppEnv = { Bindings: Env; Variables: { sql: postgres.Sql; auth: AuthClaims } };
