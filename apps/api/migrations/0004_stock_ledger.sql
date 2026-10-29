-- Sprint 2: append-only stock ledger, cached balances, approved adjustments, physical counts.
ALTER TABLE businesses ADD COLUMN allow_negative_stock boolean NOT NULL DEFAULT false;

CREATE TABLE stock_movements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('OPENING','ADJUSTMENT','COUNT','SALE','PURCHASE','RETURN','TRANSFER_IN','TRANSFER_OUT')),
  quantity numeric(14,3) NOT NULL CHECK (quantity <> 0),
  unit_cost_cents bigint NOT NULL DEFAULT 0,
  balance_after numeric(14,3) NOT NULL,
  reason text,
  ref_type text,
  ref_id text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, branch_id) REFERENCES branches (business_id, id),
  FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id)
);
CREATE INDEX stock_movements_product_idx ON stock_movements (business_id, product_id, created_at DESC);

CREATE TABLE stock_balances (
  business_id uuid NOT NULL REFERENCES businesses(id),
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  on_hand numeric(14,3) NOT NULL DEFAULT 0,
  avg_cost_cents bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, branch_id, product_id),
  FOREIGN KEY (business_id, branch_id) REFERENCES branches (business_id, id),
  FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id)
);

CREATE TABLE stock_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity <> 0),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  requested_by uuid NOT NULL REFERENCES users(id),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, branch_id) REFERENCES branches (business_id, id),
  FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id)
);

CREATE TABLE stock_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  branch_id uuid NOT NULL,
  note text,
  counted_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, branch_id) REFERENCES branches (business_id, id)
);
CREATE TABLE stock_count_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  count_id uuid NOT NULL REFERENCES stock_counts(id),
  product_id uuid NOT NULL,
  expected numeric(14,3) NOT NULL,
  counted numeric(14,3) NOT NULL CHECK (counted >= 0),
  variance numeric(14,3) NOT NULL,
  FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_movements','stock_balances','stock_adjustments','stock_counts','stock_count_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid)$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kpos_app') THEN
    GRANT SELECT, INSERT ON stock_movements, stock_counts, stock_count_lines TO kpos_app;
    GRANT SELECT, INSERT, UPDATE ON stock_balances, stock_adjustments TO kpos_app;
  END IF;
END $$;
