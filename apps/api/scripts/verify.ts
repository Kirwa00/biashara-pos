import postgres from "postgres";
import { withTenant } from "../src/db.ts";
import { integrityReport } from "../src/integrity.ts";

// Restore drill / books check across every business. Exits 1 if any invariant fails.
const url = process.env.VERIFY_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://kpos_owner:postgres@localhost:5432/kenya_pos";
const sql = postgres(url, { max: 1, onnotice: () => {} });
const ids = (await sql<{ id: string }[]>`SELECT id FROM job_business_ids()`).map((r) => r.id);
const [counts] = await sql`SELECT (SELECT count(*) FROM documents)::int AS documents, (SELECT count(*) FROM stock_movements)::int AS movements, (SELECT count(*) FROM payments)::int AS payments`;
let bad = 0;
for (const bid of ids) {
  const r = await withTenant(sql, bid, (tx) => integrityReport(tx));
  if (r.ok) continue;
  bad++;
  console.error(`business ${bid}: ${r.failed.join(", ")}`, JSON.stringify(Object.fromEntries(r.failed.map((k) => [k, r.checks[k as keyof typeof r.checks].slice(0, 3)]))));
}
console.log(`checked ${ids.length} businesses, ${counts!.documents} documents, ${counts!.movements} stock movements, ${counts!.payments} payments: ${bad ? `${bad} with problems` : "all reconcile"}`);
await sql.end();
process.exit(bad ? 1 : 0);
