-- Log of reminders sent to customers with overdue invoices (sent from the user's own WhatsApp/SMS).
CREATE TABLE payment_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  channel text NOT NULL CHECK (channel IN ('WHATSAPP', 'SMS', 'CALL')),
  overdue_cents bigint NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_reminders_customer_idx ON payment_reminders (business_id, customer_id, created_at);

ALTER TABLE payment_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_reminders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_reminders USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kpos_app') THEN GRANT SELECT, INSERT ON payment_reminders TO kpos_app; END IF;
END $$;
