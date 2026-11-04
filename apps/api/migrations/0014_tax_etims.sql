-- Sprint 9: tax records kept apart from revenue, KRA code mapping, eTIMS (OSCU) submission queue.

-- KRA item classification / quantity unit / packaging unit codes (etims_item_code already exists).
ALTER TABLE products ADD COLUMN kra_item_class_code text, ADD COLUMN kra_unit_code text, ADD COLUMN kra_pkg_unit_code text;

-- Per business: the OSCU device registration. The communication key is AES-GCM encrypted like PayHero passwords.
CREATE TABLE etims_settings (
  business_id uuid PRIMARY KEY REFERENCES businesses(id),
  environment text NOT NULL DEFAULT 'SANDBOX' CHECK (environment IN ('SANDBOX', 'PRODUCTION')),
  tin text NOT NULL,
  bhf_id text NOT NULL DEFAULT '00',
  device_serial text NOT NULL,
  cmc_key_enc text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per fiscal document per tax code; credit notes carry sign -1. Revenue stays in document_lines.
CREATE TABLE tax_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  tax_code char(1) NOT NULL,
  rate_bp int NOT NULL,
  sign smallint NOT NULL CHECK (sign IN (1, -1)),
  taxable_cents bigint NOT NULL,
  tax_cents bigint NOT NULL,
  issue_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, tax_code)
);
CREATE INDEX tax_records_period_idx ON tax_records (business_id, issue_date);

-- invc_no is the KRA invoice number: one sequence per business across sales, invoices and credit notes.
CREATE TABLE etims_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  invc_no int NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'SUBMITTED', 'FAILED', 'DEAD')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  rcpt_no text,
  rcpt_sign text,
  internal_data text,
  kra_taxable_cents bigint,
  kra_tax_cents bigint,
  kra_total_cents bigint,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, invc_no)
);
CREATE INDEX etims_submissions_document_idx ON etims_submissions (business_id, document_id);
CREATE INDEX etims_submissions_due_idx ON etims_submissions (business_id, next_attempt_at) WHERE status IN ('QUEUED', 'FAILED');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['etims_settings','tax_records','etims_submissions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- eTIMS failures and reconciliation differences join the notification centre.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('LOW_STOCK', 'OVERDUE_INVOICES', 'PAYMENT_ISSUES', 'PO_ACTION', 'DAILY_SUMMARY', 'ETIMS_ISSUES'));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kpos_app') THEN
    GRANT SELECT, INSERT, UPDATE ON etims_settings, etims_submissions TO kpos_app;
    GRANT SELECT, INSERT ON tax_records TO kpos_app;
  END IF;
END $$;
