-- Purchase orders: raised -> approved -> received (in part or full). Stock moves only on receipt (GRN in purchases).
CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  number int NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'PARTIAL', 'RECEIVED', 'CANCELLED')),
  note text,
  total_cents bigint NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, number),
  FOREIGN KEY (business_id, branch_id) REFERENCES branches (business_id, id),
  FOREIGN KEY (business_id, supplier_id) REFERENCES suppliers (business_id, id)
);
CREATE TABLE purchase_order_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  quantity_ordered numeric(14,3) NOT NULL CHECK (quantity_ordered > 0),
  quantity_received numeric(14,3) NOT NULL DEFAULT 0 CHECK (quantity_received >= 0 AND quantity_received <= quantity_ordered),
  unit_cost_cents bigint NOT NULL,
  UNIQUE (purchase_order_id, product_id),
  FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id)
);
ALTER TABLE purchases ADD COLUMN purchase_order_id uuid REFERENCES purchase_orders(id);

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchase_orders USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchase_order_lines USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kpos_app') THEN GRANT SELECT, INSERT, UPDATE ON purchase_orders, purchase_order_lines TO kpos_app; END IF;
END $$;
