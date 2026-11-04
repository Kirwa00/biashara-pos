-- BiasharaPOS's own subscriptions: every business gets a 14-day trial, then pays by M-Pesa to stay writable.
-- The seller is the business of the first registered SUPER_ADMIN_EMAILS address; its plans are ordinary products in its catalog.

-- ADD COLUMN with a default fills existing rows without touching RLS: everyone already here gets 14 days from this migration.
ALTER TABLE businesses
  ADD COLUMN trial_ends_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  ADD COLUMN paid_until timestamptz,
  ADD COLUMN plan text CHECK (plan IN ('STARTER','COMMERCIAL','ENTERPRISE')),
  ADD COLUMN next_plan text CHECK (next_plan IN ('STARTER','COMMERCIAL')), -- chosen for the next payment; plan changes only once paid
  ADD COLUMN billing_cycle text CHECK (billing_cycle IN ('MONTHLY','ANNUAL')),
  ADD COLUMN billing_phone text,
  ADD COLUMN billing_customer_id uuid,
  ADD COLUMN last_billing_prompt date;

-- Platform-level, spanning two tenants (client and seller), so no RLS like admin_actions: only billing.ts reads it, always filtered by business_id.
-- The seller's invoice is created only when money is confirmed, so its books and KRA submissions never include unpaid prompts.
CREATE TABLE subscription_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  seller_business_id uuid NOT NULL REFERENCES businesses(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  plan text NOT NULL CHECK (plan IN ('STARTER','COMMERCIAL')),
  cycle text NOT NULL CHECK (cycle IN ('MONTHLY','ANNUAL')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  line jsonb NOT NULL,
  phone text NOT NULL,
  source text NOT NULL CHECK (source IN ('OWNER','AUTO')),
  -- REVIEW: PayHero reported a different amount, so a person must look at it. It does not block new prompts.
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','FAILED','REVIEW')),
  provider_ref text,
  reference text,
  document_id uuid REFERENCES documents(id),
  paid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX subscription_payments_business_idx ON subscription_payments (business_id, created_at DESC);
-- One waiting prompt per business, so a client can never be charged twice for the same period.
CREATE UNIQUE INDEX subscription_payments_one_pending_uq ON subscription_payments (business_id) WHERE status = 'PENDING';

-- Runs in the seller's transaction, so it can't reach the client's row through RLS. Unused trial days are kept: time is added to whichever is latest.
CREATE FUNCTION extend_subscription(p_business uuid, p_plan text, p_cycle text) RETURNS timestamptz
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE businesses SET plan = p_plan, billing_cycle = p_cycle, last_billing_prompt = NULL,
    status = CASE WHEN status = 'SUSPENDED' THEN status ELSE 'ACTIVE' END,
    paid_until = greatest(paid_until, trial_ends_at, now()) + CASE p_cycle WHEN 'ANNUAL' THEN interval '1 year' ELSE interval '1 month' END
  WHERE id = p_business RETURNING paid_until
$$;

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('LOW_STOCK', 'OVERDUE_INVOICES', 'PAYMENT_ISSUES', 'PO_ACTION', 'DAILY_SUMMARY', 'ETIMS_ISSUES', 'BILLING'));

DROP FUNCTION admin_businesses();
CREATE FUNCTION admin_businesses() RETURNS TABLE (
  id uuid, name text, status text, phone text, kra_pin text, created_at timestamptz, owner_email text, owner_name text,
  users int, branches int, documents_30d int, sales_30d_cents bigint, last_activity timestamptz,
  plan text, billing_cycle text, trial_ends_at timestamptz, paid_until timestamptz
)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT b.id, b.name, b.status, b.phone, b.kra_pin, b.created_at,
    (SELECT u.email FROM users u WHERE u.business_id = b.id AND u.role = 'OWNER' ORDER BY u.created_at LIMIT 1),
    (SELECT u.name FROM users u WHERE u.business_id = b.id AND u.role = 'OWNER' ORDER BY u.created_at LIMIT 1),
    (SELECT count(*)::int FROM users u WHERE u.business_id = b.id AND u.is_active),
    (SELECT count(*)::int FROM branches br WHERE br.business_id = b.id),
    (SELECT count(*)::int FROM documents d WHERE d.business_id = b.id AND d.type IN ('SALE','INVOICE') AND d.created_at > now() - interval '30 days'),
    (SELECT coalesce(sum(d.total_cents), 0)::bigint FROM documents d WHERE d.business_id = b.id AND d.type IN ('SALE','INVOICE') AND d.created_at > now() - interval '30 days'),
    (SELECT max(a.created_at) FROM audit_logs a WHERE a.business_id = b.id),
    b.plan, b.billing_cycle, b.trial_ends_at, b.paid_until
  FROM businesses b ORDER BY b.created_at DESC
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kpos_app') THEN
    GRANT SELECT, INSERT, UPDATE ON subscription_payments TO kpos_app;
    GRANT EXECUTE ON FUNCTION extend_subscription(uuid, text, text) TO kpos_app;
    GRANT EXECUTE ON FUNCTION admin_businesses() TO kpos_app;
  END IF;
END $$;
