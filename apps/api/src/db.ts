import postgres from "postgres";
import type { Env } from "./env";

export function createSql(env: Env): postgres.Sql {
  const url = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!url) throw new Error("No database configured (HYPERDRIVE or DATABASE_URL)");
  return postgres(url, { max: 5, fetch_types: false, prepare: true });
}

/** Runs fn in a transaction scoped by RLS to one business. All tenant data access must go through this. */
export function withTenant<T>(sql: postgres.Sql, businessId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.business_id', ${businessId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

export async function audit(
  tx: postgres.TransactionSql,
  e: { businessId: string; userId?: string | null; action: string; entity: string; entityId?: string; after?: unknown; before?: unknown; ip?: string | null },
) {
  await tx`INSERT INTO audit_logs (business_id, user_id, action, entity, entity_id, before, after, ip)
    VALUES (${e.businessId}, ${e.userId ?? null}, ${e.action}, ${e.entity}, ${e.entityId ?? null},
      ${e.before === undefined ? null : tx.json(e.before as never)}, ${e.after === undefined ? null : tx.json(e.after as never)}, ${e.ip ?? null})`;
}
