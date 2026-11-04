-- M-Pesa prompts sent from the till. The sale is recorded only when the money is confirmed, so a cancelled prompt leaves no sale, stock movement or KRA submission behind.
CREATE TABLE till_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  created_by uuid NOT NULL REFERENCES users(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  customer_id uuid REFERENCES customers(id),
  lines jsonb NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  phone text NOT NULL,
  idempotency_key text NOT NULL,
  -- REVIEW: the customer paid but the sale could not be recorded as it stood (say, stock ran out), or PayHero reported a different amount. A person must look at it.
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','FAILED','REVIEW')),
  provider_ref text,
  reference text,
  error text,
  document_id uuid REFERENCES documents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (business_id, idempotency_key)
);

ALTER TABLE till_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE till_prompts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON till_prompts USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kpos_app') THEN
    GRANT SELECT, INSERT, UPDATE ON till_prompts TO kpos_app;
  END IF;
END $$;
