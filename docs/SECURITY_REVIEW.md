# S10 security review and definition-of-done status

This review was done against `docs/kenya_pos_sdlc.md` §9–10 at the end of S10 (November 2026). It covers the API (`apps/api`), the web app (`apps/web`) and the database migrations.

## Findings fixed in S10

| # | Finding | Fix |
|---|---|---|
| 1 | No rate limits: sign-in, refresh and STK could be brute-forced or spammed | Workers Rate Limiting bindings (`AUTH_LIMITER` 10/min/IP on `/v1/auth/*` and `/v1/payments/stk`, `API_LIMITER` 600/min/IP on `/v1/*`), plus WAF rules in `OPERATIONS.md` |
| 2 | No request-size cap | 2 MB body limit on `/v1/*` (413) |
| 3 | No way to revoke a team member's access | `PATCH /v1/users/:id` (owner): change role or switch off; switching off revokes refresh tokens; owners and self are protected; audited |
| 4 | Sidebar showed a hard-coded "eTIMS VSCU Connected" badge | Removed in S9; the eTIMS page shows the real connection state |
| 5 | Web app had no security headers or CSP | `apps/web/public/_headers`: CSP (`connect-src 'self'`, `frame-ancestors 'none'`), nosniff, frame-deny, referrer policy, HSTS |
| 6 | Backups and restore were untested | Nightly R2 dump workflow, monthly restore drill, and `db:verify` books check; CI runs the same books check over all test data |
| 7 | eTIMS key decrypt fell back to an empty key | Uses the same `ENCRYPTION_KEY` guard as PayHero (fails loudly) |

## Controls confirmed in place

- **Tenant isolation:** every tenant table has `ENABLE` + `FORCE ROW LEVEL SECURITY` with a `tenant_isolation` policy. The app role is not a superuser. All tenant access goes through `withTenant`. Cross-tenant tests exist for every module (`tenant.test.ts`, plus each feature test).
- **Pre-tenant lookups** go only through narrow `SECURITY DEFINER` functions: `auth_lookup`, `refresh_lookup`, `payhero_token_lookup`, `job_business_ids`.
- **Passwords:** PBKDF2-SHA256 at 100k iterations (the Workers maximum) with a per-user salt and constant-time compare. Accounts lock for 15 minutes after 5 failures, and unknown emails are answered in the same time as known ones.
- **Sessions:** 15-minute HS256 access tokens. Refresh tokens are stored hashed, rotated on use with replay protection, and revoked at logout.
- **Permissions:** role checks on every route (`requirePermission`); cashiers can't see reports, settings or notifications.
- **Money:** integer cents everywhere. Payment callbacks are idempotent and verified against PayHero's transaction-status API, so the callback body is never trusted. An M-Pesa code can't be reused.
- **Audit:** price-affecting and financial writes call `audit()`. `audit_logs` is append-only for the app role, and posted documents are never deleted.
- **Secrets:** PayHero passwords and eTIMS cmcKeys are AES-256-GCM encrypted and never returned by the API.

## Accepted risks (documented for release)

| Risk | Why accepted | Mitigation |
|---|---|---|
| Sessions are kept in `localStorage` (readable by any script on the page) | Needed for the offline till; CSP blocks third-party scripts | Short access TTL, refresh rotation, CSP `script-src 'self'` |
| A switched-off user's access token works for up to 15 minutes | Avoids a database lookup on every request | Refresh tokens are revoked at once; rotate `JWT_SECRET` in an emergency |
| Rate limits are per IP; tills behind one NAT share a limit | Workers Rate Limiting keys on what's available before auth | Generous API ceiling (600/min); tighten per business later |
| eTIMS payload follows the published OSCU spec but hasn't been run against KRA's sandbox | Needs the owner's KRA onboarding credentials | Sandbox environment toggle; reconciliation flags anything KRA didn't accept |
| Database tests have not been run on the developer machine (no Docker there) | CI runs them on every push against Postgres 16 | CI is required to pass before merge |

## Definition of done (§9)

| Item | Status |
|---|---|
| All critical acceptance tests pass | Covered by `apps/api/test/*`. Quotation convert-once, M-Pesa unpaid until confirmed, duplicate callback no-op, partial payments, stock on sale and receipt, count variance, reorder alert, eTIMS reconciliation, P&L totals, cross-tenant denial, and restore verification all run in CI |
| Financial and stock calculations reconcile | `db:verify` runs in CI over all test data and in the monthly restore drill; owners can run `GET /v1/reports/integrity` |
| Payment and tax integration errors are recoverable | PayHero status re-checks, manual code confirmation; eTIMS retry queue with backoff, manual retry, failure alerts |
| Authorization and tenant-isolation tests pass | In CI |
| Backups and recovery have been tested | The restore-drill workflow tests itself on seeded data now; **it must be run once against a real R2 backup after setup** (`GO_LIVE.md` §6) |
| Pilot users can complete the main workflows | To be confirmed with the pilot shop (`GO_LIVE.md` §7) |
| Outstanding defects documented and approved | The accepted risks above; the owner signs off before the pilot |
