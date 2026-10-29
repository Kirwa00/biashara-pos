# BiasharaPOS (kenya-pos)

Multi-tenant POS & business management SaaS for Kenyan SMEs. Requirements: [`docs/kenya_pos_sdlc.md`](docs/kenya_pos_sdlc.md) (source of truth). Plan: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md). UI tokens: [`docs/DESIGN.md`](docs/DESIGN.md).

| Path | What |
|---|---|
| `packages/shared` | Money (integer cents), VAT/eTIMS tax codes, roles & permissions, zod schemas |
| `apps/api` | Hono on Cloudflare Workers, Postgres (Neon via Hyperdrive), row-level security per business |
| `apps/web` | React + Vite + Tailwind PWA (till + back office) |

## Local dev
```bash
npm install
# Postgres 14+: superuser for migrations + non-owner app role (RLS applies to it)
psql -c "CREATE ROLE kpos_app LOGIN PASSWORD 'app';"
MIGRATE_DATABASE_URL=postgres://<superuser>@localhost:5432/kenya_pos npm run db:migrate
cp apps/api/.dev.vars.example apps/api/.dev.vars
npm run dev:api   # :8787
npm run dev:web   # :5173 (proxies /v1 to the API)
npm run db:seed   # demo owner@demo.ke / demo-password-1
```
Checks: `npm run typecheck && npm test && npm run build`.

## Tenancy rule
All tenant reads/writes go through `withTenant(sql, businessId, fn)`, which sets `app.business_id` for the transaction. Postgres RLS (`FORCE ROW LEVEL SECURITY`) blocks every row of other businesses, so a missing `WHERE business_id` can't leak data. The app must connect as a non-owner, non-superuser role.
