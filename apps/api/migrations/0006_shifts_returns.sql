-- Prototype skeleton: till shifts with cash-up, and credit notes (returns/refunds).
ALTER TABLE documents DROP CONSTRAINT documents_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_type_check CHECK (type IN ('QUOTE','INVOICE','SALE','CREDIT_NOTE'));
ALTER TABLE document_lines ADD COLUMN source_line_id bigint REFERENCES document_lines(id);

CREATE TABLE shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  branch_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  opening_float_cents bigint NOT NULL CHECK (opening_float_cents >= 0),
  expected_cash_cents bigint,
  counted_cash_cents bigint,
  note text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  FOREIGN KEY (business_id, branch_id) REFERENCES branches (business_id, id)
);
CREATE UNIQUE INDEX shifts_one_open_uq ON shifts (business_id, user_id) WHERE status = 'OPEN';

-- Refunds are payments with direction -1; cash-up nets them.
ALTER TABLE payments ADD COLUMN shift_id uuid REFERENCES shifts(id);
ALTER TABLE payments ADD COLUMN direction smallint NOT NULL DEFAULT 1 CHECK (direction IN (1, -1));

ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shifts USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kpos_app') THEN GRANT SELECT, INSERT, UPDATE ON shifts TO kpos_app; END IF;
END $$;
