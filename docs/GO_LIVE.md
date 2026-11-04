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

1. The domain is `biasharapos.com`, bought through Cloudflare, so the zone already exists and there are no nameservers to change.
2. **Hyperdrive:** create one pointing at the Neon `kpos_app` connection string, with **query caching off**. Put its id in `apps/api/wrangler.toml` by uncommenting the `[[hyperdrive]]` block.
3. **Secrets** for the API Worker, run from `apps/api`:
   ```bash
   npx wrangler secret put JWT_SECRET        # 32+ random bytes, e.g. `openssl rand -base64 48`
   npx wrangler secret put ENCRYPTION_KEY    # 32+ random bytes; encrypts PayHero passwords and the eTIMS key. Never change it once set.
   npx wrangler secret put RESEND_API_KEY    # step 5
   ```
   `APP_ORIGIN` and `EMAIL_FROM` are already set in `[vars]` in `apps/api/wrangler.toml`. `keep_vars` is on, so a deploy leaves variables set in the dashboard alone.
4. **Deploy the API:** run `npm run build -w @kpos/api`, then `npx wrangler deploy` from `apps/api`. That one deploy also sets up:
   - the cron triggers (08:00 and 20:00 EAT, and eTIMS every 15 minutes);
   - the `AUTH_LIMITER` and `API_LIMITER` rate limits.
5. **Deploy the web app:** run `npm run build -w @kpos/web`, then `npx wrangler deploy` from `apps/web`.
   - `apps/web/wrangler.toml` attaches `biasharapos.com` and `www.biasharapos.com` as custom domains on deploy; `www` redirects to the main address.
   - No route is needed: the web Worker forwards `/v1` to `kenya-pos-api` itself. The old `https://kenya-pos-web.<your-subdomain>.workers.dev` address keeps working so tills can sync queued offline sales. Sign-ins and installed till apps don't carry over between addresses: sync first, then sign in and reinstall on the new one.
6. **WAF and rate-limit rules:** see `docs/OPERATIONS.md` §1.

**Check:** `https://biasharapos.com/health` returns `{"ok":true}`, `https://www.biasharapos.com/` redirects to `https://biasharapos.com/`, and you can register a business at `https://biasharapos.com/register`.

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

1. Register your own account at `https://biasharapos.com/register`. Use any business name, e.g. "BiasharaPOS HQ".
2. **Only after that account exists**, set the Worker variable `SUPER_ADMIN_EMAILS` to your email (comma-separate several). Registering first matters: until an email is registered, anyone could register it.
3. Sign in again. **Platform Admin** appears in the sidebar:
   - see every business, with its owner, status, users, 30-day sales and last activity;
   - suspend or reactivate a business;
   - "View as owner" opens a 15-minute **read-only** support view. It can't change anything or export data, and it's logged in both the platform log and the shop's own audit log.

## 8. Subscriptions (how clients pay you)

Every new business gets a 14-day free trial. Billing is on as soon as a `SUPER_ADMIN_EMAILS` address is registered: that address's business is the **seller**, and it never pays or gets restricted.

1. Sign in as the seller and connect **your own** PayHero account in **PayHero Settings**. Client payments go there.
2. The plans appear in your **Products & Catalog** the first time a client opens Billing: `PLAN-STARTER-MONTHLY`, `PLAN-STARTER-ANNUAL`, `PLAN-COMMERCIAL-MONTHLY`, `PLAN-COMMERCIAL-ANNUAL`.
   - **To change a price,** edit the product. Then update the prices on the landing page by hand.
   - **Check the VAT setting.** They start as VAT 16%, price inclusive. If you aren't VAT-registered, change each to **Non-VAT**, or your reports will show VAT you don't owe.
3. Each client is a customer in your books, and each confirmed payment is a paid invoice. Nothing is recorded until money is confirmed, so unpaid prompts never reach your reports or KRA.

**What runs automatically (08:00 EAT daily):**
- Reminders to owners 7, 3 and 1 days before the end, and through the grace period.
- An M-Pesa prompt on the last day and each grace day, if the owner saved a plan and number. M-Pesa always asks for their PIN.
- After 3 days of grace the business is read-only: it can sign in, view, export and pay, but not sell or change anything. Queued offline sales are kept and sync after payment. Paying unlocks it within seconds.

**What needs you:**
- **Enterprise, bank or cash payments, free pilots:** **Platform Admin → Subscription** sets the plan and paid-up date by hand. Raise any invoice yourself as a normal sale.
- **Refunds:** do them in PayHero, then correct the paid-up date the same way. A credit note doesn't shorten a subscription.
- **Payments marked "needs checking":** PayHero reported a different amount. Nothing was credited, so check it in PayHero and set the date by hand if it's genuine.

## 9. Before the first pilot shop

- Register the pilot business. In **Team & Branches**, add each teller under **Add till login** with a username and 4-digit PIN. They sign in at `/till-login` with the shop code shown there, and see only the till, shifts, sales and invoices, and customers. The owner can reset a PIN there; five wrong tries lock a login for 15 minutes.
- Import products (CSV), opening stock, and customers with credit limits.
- Open a shift, make a sale, run the Z-report, and check **Financial Reports** against the drawer.
- Install the app on the till device: Chrome shows **Install app** in the header, or use "Add to Home screen".
- Read `docs/OPERATIONS.md` §4 so you know what to do if something breaks.
