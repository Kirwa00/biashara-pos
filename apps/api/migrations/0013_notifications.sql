-- Sprint 8: notification centre filled by scheduled jobs; owners also get them by email (Resend).
-- dedupe_key makes every job idempotent: a re-run for the same period inserts nothing and sends nothing.
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  kind text NOT NULL CHECK (kind IN ('LOW_STOCK', 'OVERDUE_INVOICES', 'PAYMENT_ISSUES', 'PO_ACTION', 'DAILY_SUMMARY')),
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  dedupe_key text NOT NULL,
  email_status text NOT NULL DEFAULT 'PENDING' CHECK (email_status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  email_attempts int NOT NULL DEFAULT 0,
  emailed_at timestamptz,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, dedupe_key)
);
CREATE INDEX notifications_business_created_idx ON notifications (business_id, created_at DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notifications USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- Cron jobs run before any tenant is known; expose only the list of businesses to visit.
CREATE FUNCTION job_business_ids() RETURNS TABLE (id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM businesses WHERE status <> 'SUSPENDED' ORDER BY created_at
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kpos_app') THEN
    GRANT SELECT, INSERT, UPDATE ON notifications TO kpos_app;
    GRANT EXECUTE ON FUNCTION job_business_ids() TO kpos_app;
  END IF;
END $$;
