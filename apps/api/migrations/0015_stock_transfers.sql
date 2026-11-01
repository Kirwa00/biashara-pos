-- Gate 4: move stock between branches. Sending posts TRANSFER_OUT at the source; receiving posts TRANSFER_IN at the destination
-- at the source's average cost, so value travels with the goods. Shortfalls stay recorded on the line.
CREATE TABLE stock_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  number int NOT NULL,
  from_branch_id uuid NOT NULL,
  to_branch_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED')),
  note text,
  created_by uuid NOT NULL REFERENCES users(id),
  sent_by uuid REFERENCES users(id),
  sent_at timestamptz,
  received_by uuid REFERENCES users(id),
  received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, number),
  CHECK (from_branch_id <> to_branch_id),
  FOREIGN KEY (business_id, from_branch_id) REFERENCES branches (business_id, id),
  FOREIGN KEY (business_id, to_branch_id) REFERENCES branches (business_id, id)
);
CREATE TABLE stock_transfer_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  transfer_id uuid NOT NULL REFERENCES stock_transfers(id),
  product_id uuid NOT NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  quantity_received numeric(14,3),
  unit_cost_cents bigint,
  UNIQUE (transfer_id, product_id),
  FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_transfers','stock_transfer_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kpos_app') THEN
    GRANT SELECT, INSERT, UPDATE ON stock_transfers, stock_transfer_lines TO kpos_app;
  END IF;
END $$;
