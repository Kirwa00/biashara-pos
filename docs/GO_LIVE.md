# Go-live setup checklist

Everything in the code is built through S10. These are the steps only the owner can do: accounts, keys, and settings on outside services. Work through them in order. Each step says how to check it worked.

## 1. Database: Neon Postgres

1. Create a Neon project in **eu-central-1 (Frankfurt)**, Postgres 16. Make two branches: `main` for production and `staging`.
2. Create two roles:
   - `kpos_owner`: runs migrations and owns the tables.
   - `kpos_app`: what the API logs in as. Give it LOGIN only; no superuser, no BYPASSRLS.

   ```sql
   CREATE ROLE kpos_app LOGIN PASSWORD '<strong password>';
   ```
   The migrations grant `kpos_app` exactly the table rights it needs. Row-level security keeps every business apart.
3. Run the migrations as the owner, from `apps/api`:
   ```bash
   MIGRATE_DATABASE_URL="postgres://kpos_owner:<pw>@<neon-host>/neondb?sslmode=require" npm run db:migrate
   ```
   **Check:** it prints `applied 0001_…` through `applied 0014_…`.
4. Optional: run `npm run db:verify` with `VERIFY_DATABASE_URL` set to the owner URL. It should say `all reconcile`.

## 2. Cloudflare

1. Add your domain as a Cloudflare zone. A `.co.ke` domain works: change the nameservers at your registrar.
2. **Hyperdrive:** create one pointing at the Neon `kpos_app` connection string, with **query caching off**. Put its id in `apps/api/wrangler.toml` by uncommenting the `[[hyperdrive]]` block.
3. **Secrets** for the API Worker, run from `apps/api`:
   ```bash
   npx wrangler secret put JWT_SECRET        # 32+ random bytes, e.g. `openssl rand -base64 48`
   npx wrangler secret put ENCRYPTION_KEY    # 32+ random bytes; encrypts PayHero passwords and the eTIMS key. Never change it once set.
   npx wrangler secret put RESEND_API_KEY    # step 5
   ```
   Set the plain variables `APP_ORIGIN=https://app.<domain>` and `EMAIL_FROM="BiasharaPOS <alerts@<domain>>"` in `[vars]` or in the dashboard.
4. **Deploy the API:** run `npm run build -w @kpos/api`, then `npx wrangler deploy` from `apps/api`. That one deploy also sets up:
   - the cron triggers (08:00 and 20:00 EAT, and eTIMS every 15 minutes);
   - the `AUTH_LIMITER` and `API_LIMITER` rate limits.
5. **Deploy the web app:** run `npm run build -w @kpos/web`, then `npx wrangler deploy` from `apps/web`.
   - Attach the custom domain `app.<domain>`.
   - Add a Workers route `app.<domain>/v1/*` → `kenya-pos-api`. The app calls the API on its own origin.
6. **WAF and rate-limit rules:** see `docs/OPERATIONS.md` §1.

**Check:** `https://app.<domain>/health` returns `{"ok":true}`, and you can register a business at `https://app.<domain>/register`.

## 3. PayHero (M-Pesa STK)

1. In the PayHero dashboard, create API credentials (username and password) and note your **channel id** (till or paybill).
2. In the app, an owner opens **PayHero Settings** and enters the username, password and channel id, then saves. The password is stored encrypted.
3. The callback URL is shown on that page. PayHero receives it with each request, so nothing to configure there.

**Check:** on the till, take a KSh 1 STK payment to your own phone. The invoice should only show as paid after you enter your PIN.

## 4. KRA eTIMS (OSCU)

1. Apply for **OSCU** integration on the KRA eTIMS portal using your KRA PIN. You receive a **device serial**. Initialising the device gives you a **communication key (cmcKey)** and a **branch id** (usually `00`).
2. Register your items with KRA and note each item's **item code** and **classification code**.
3. In the app, the owner opens **eTIMS Tax Center**:
   - **KRA item codes:** enter the codes for every product.
   - **eTIMS device:** choose environment **Sandbox**, enter the PIN, branch id, serial and cmcKey, tick **Submit documents to KRA**, and save.
4. Make test sales. Within 15 minutes they show **SUBMITTED** with a KRA receipt number, and the reconciliation panel says books and KRA agree.
5. Once KRA certifies you, switch the environment to **Production**.

> The built-in OSCU URLs (`etims-api-sbx.kra.go.ke` and `etims-api.kra.go.ke`) and the `saveSales` field names follow KRA's published OSCU spec. If KRA gives you different URLs, set the `ETIMS_BASE_URL` variable on the API Worker. Check the receipt fields KRA expects during sandbox testing.

## 5. Resend (owner emails)

1. Create a Resend account and add your domain. Add the DNS records Resend shows (SPF, DKIM) in Cloudflare DNS.
2. Create an API key and set it with `npx wrangler secret put RESEND_API_KEY`.
3. Set `EMAIL_FROM` to an address on the verified domain.

**Check:** the next 08:00 or 20:00 run emails the owners. Each notification in **Notifications** shows "Emailed to owners". Without Resend, alerts still appear in the app and show "In-app only".

## 6. Backups

1. In Cloudflare R2, create a **private** bucket, e.g. `kpos-backups`.
   - Add a lifecycle rule that deletes objects after 30 days.
   - Create an R2 API token with read/write on that bucket only.
2. In GitHub, go to repository **Settings → Secrets → Actions** and add:
   - `BACKUP_DATABASE_URL`: a direct Neon URL for a read-only role, not Hyperdrive
   - `R2_ACCOUNT_ID`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_BACKUP_BUCKET`
3. Run **Actions → Nightly backup → Run workflow** once by hand, then **Actions → Restore drill → Run workflow**.

**Check:** the drill ends with `checked N businesses … all reconcile`. Neon's point-in-time restore is a second line of defence; keep it on (Launch plan or higher).

## 7. Platform admin (you)

1. Register your own account at `https://app.<domain>/register`. Use any business name, e.g. "BiasharaPOS HQ".
2. **Only after that account exists**, set the Worker variable `SUPER_ADMIN_EMAILS` to your email (comma-separate several). Registering first matters: until an email is registered, anyone could register it.
3. Sign in again. **Platform Admin** appears in the sidebar:
   - see every business, with its owner, status, users, 30-day sales and last activity;
   - suspend or reactivate a business;
   - "View as owner" opens a 15-minute **read-only** support view. It can't change anything or export data, and it's logged in both the platform log and the shop's own audit log.

## 8. Before the first pilot shop

- Register the pilot business. Add its team with the right roles; cashiers get the till only.
- Import products (CSV), opening stock, and customers with credit limits.
- Open a shift, make a sale, run the Z-report, and check **Financial Reports** against the drawer.
- Install the app on the till device: Chrome shows **Install app** in the header, or use "Add to Home screen".
- Read `docs/OPERATIONS.md` §4 so you know what to do if something breaks.
