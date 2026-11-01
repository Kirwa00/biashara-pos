# Operations runbook

## 1. Edge protection (Cloudflare WAF)

These are configured in the Cloudflare dashboard (Security → WAF), not in code. Code-level limits already exist in two places:
- the Workers Rate Limiting bindings in `apps/api/wrangler.toml`: 10 sign-in/STK requests per minute per IP, and 600 API requests per minute per IP;
- a 2 MB request-body cap.

The WAF stops abuse before it reaches the Worker.

| Rule | Expression | Action |
|---|---|---|
| Managed rules | Cloudflare Managed Ruleset + OWASP Core (paranoia 1) | Block |
| Sign-in brute force | `http.request.uri.path in {"/v1/auth/login" "/v1/auth/register" "/v1/auth/refresh"}`, 20 requests / 1 min per IP | Block 10 min |
| STK abuse | `http.request.uri.path eq "/v1/payments/stk"`, 30 / 1 min per IP | Block 10 min |
| Webhook method | `starts_with(http.request.uri.path, "/v1/webhooks/") and http.request.method ne "POST"` | Block |
| API outside Kenya (optional, after the pilot) | `starts_with(http.request.uri.path, "/v1/") and ip.geoip.country ne "KE" and not starts_with(http.request.uri.path, "/v1/webhooks/")` | Managed challenge |

Keep "Always use HTTPS", HSTS and TLS 1.2+ on. The web app sends its own security headers (CSP, frame-deny, nosniff) from `apps/web/public/_headers`.

## 2. Scheduled jobs

| Cron (UTC) | EAT | Job | Idempotency |
|---|---|---|---|
| `0 5 * * *` | 08:00 | Low stock, overdue invoices, M-Pesa issues, POs, eTIMS issues → notifications + owner email | One alert per business per day per kind (`dedupe_key`) |
| `0 17 * * *` | 20:00 | Daily owner summary | Same |
| `*/15 * * * *` | every 15 min | eTIMS submission queue | Each row is leased before the KRA call; `invc_no` is unique |

Logs: `npx wrangler tail kenya-pos-api` (look for `job morning`, `job evening`, `job etims`). A job never stops for every business because one fails: the error is logged and the next business runs.

## 3. Backups and restore

- **Nightly:** `.github/workflows/backup.yml` runs at 02:30 EAT. It `pg_dump`s to R2 at `daily/<timestamp>.dump` and `latest.dump`, with a 30-day lifecycle on the bucket.
- **Point in time:** Neon PITR. Restore a branch to a timestamp in the Neon console, then point Hyperdrive at it.
- **Monthly drill:** `.github/workflows/restore-drill.yml` restores `latest.dump` into a clean Postgres 16, then runs `npm run db:verify`. Verify checks, for every business:
  - stock on hand equals the movement ledger;
  - document headers equal their lines;
  - paid amounts equal confirmed payments;
  - invoice statuses match their balances;
  - the tax ledger equals document VAT.

  A failed check fails the workflow. CI runs the same check over all test data on every push.
- **Books check in the app:** `GET /v1/reports/integrity` runs the same checks for one business.

### Restoring production from R2
1. Download the dump: `aws s3 cp s3://<bucket>/daily/<file>.dump . --endpoint-url https://<account>.r2.cloudflarestorage.com`.
2. Create a new Neon branch or database, then run `pg_restore --no-owner --no-privileges -d "<owner url>" <file>.dump`.
3. Recreate the `kpos_app` grants by running `npm run db:migrate` against it (already-applied migrations are skipped). If grants are missing, re-run the `GRANT` blocks from the migrations.
4. Run `VERIFY_DATABASE_URL=<owner url> npm run db:verify -w @kpos/api`. It must say `all reconcile`.
5. Point Hyperdrive at the restored database.

### Bad deploy
Run `npx wrangler rollback` in `apps/api` or `apps/web`. Migrations only add things; never roll back by editing an applied migration.

## 4. Incidents

| Symptom | Check | Recover |
|---|---|---|
| Till can't reach the server | Status page, `wrangler tail` | Tills keep selling: sales queue on the device and replay with their idempotency keys when back online |
| M-Pesa prompt paid but invoice still unpaid | Payment status in the invoice; PayHero dashboard | The callback re-checks with PayHero; the cashier can enter the M-Pesa code by hand (auto-confirmed against PayHero) |
| eTIMS failures | eTIMS Tax Center → Failed submissions, last error | Map missing KRA item codes, then **Retry now**. Outages retry automatically (backoff, 8 tries) |
| Owner emails missing | Notifications → email status | `FAILED` retries on the next run (3 tries); `SKIPPED` means Resend isn't configured |
| Suspected account compromise | Team & Branches, audit log (`/v1/audit`) | Switch the user off (ends their sessions within 15 minutes), change the owner password, rotate `JWT_SECRET` to sign everyone out |

## 5. Data protection

- **Retention:** financial documents, payments, stock movements and audit logs are kept for at least 7 years (KRA record-keeping) and are never deleted. Corrections are made with credit notes and adjustments. Notifications can be pruned after 12 months.
- **Personal data:** customer names, phones and KRA PINs belong to each business, and RLS keeps them apart. Exports (`/v1/export`) are owner-only.
- **Access revocation:** switching a user off in Team & Branches revokes their refresh tokens. Access tokens expire within 15 minutes.
- **Secrets:** Worker secrets only (`wrangler secret`), never in the repo. PayHero passwords and eTIMS keys are AES-GCM encrypted with `ENCRYPTION_KEY`.
