-- Prototype skeleton: documents (quote/invoice/till sale), payments, suppliers + purchases, PayHero settings.
CREATE TABLE doc_counters (
  business_id uuid NOT NULL REFERENCES businesses(id),
  type text NOT NULL,
  last_number int NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, type)
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  branch_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('QUOTE','INVOICE','SALE')),
  number int NOT NULL,
  customer_id uuid REFERENCES customers(id),
  status text NOT NULL,
  issue_date date NOT NULL DEFAULT (now() AT TIME ZONE 'Africa/Nairobi')::date,
  due_date date,
  net_cents bigint NOT NULL,
  tax_cents bigint NOT NULL,
  total_cents bigint NOT NULL,
  paid_cents bigint NOT NULL DEFAULT 0,
  source_id uuid REFERENCES documents(id),
  idempotency_key text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, type, number),
  UNIQUE (business_id, idempotency_key),
  FOREIGN KEY (business_id, branch_id) REFERENCES branches (business_id, id)
);
CREATE TABLE document_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  description text NOT NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL,
  tax_code text NOT NULL,
  net_cents bigint NOT NULL,
  tax_cents bigint NOT NULL,
  total_cents bigint NOT NULL,
  unit_cost_cents bigint NOT NULL DEFAULT 0,
  FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  document_id uuid REFERENCES documents(id),
  method text NOT NULL CHECK (method IN ('CASH','MPESA','CARD','BANK')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reference text,
  status text NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('PENDING','CONFIRMED','FAILED')),
  provider_ref text,
  phone text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_mpesa_ref_uq ON payments (business_id, reference) WHERE method = 'MPESA' AND reference IS NOT NULL;

CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  name text NOT NULL,
  phone text,
  email text,
  kra_pin text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE TABLE purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  number int NOT NULL,
  supplier_ref text,
  total_cents bigint NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, number),
  FOREIGN KEY (business_id, branch_id) REFERENCES branches (business_id, id),
  FOREIGN KEY (business_id, supplier_id) REFERENCES suppliers (business_id, id)
);
CREATE TABLE purchase_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  purchase_id uuid NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_cost_cents bigint NOT NULL,
  FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id)
);

CREATE TABLE payment_settings (
  business_id uuid PRIMARY KEY REFERENCES businesses(id),
  payhero_username text NOT NULL,
  payhero_password_enc text NOT NULL,
  channel_id int NOT NULL,
  callback_token text NOT NULL UNIQUE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Public PayHero callbacks arrive without a tenant; resolve it from the unguessable per-business token.
CREATE FUNCTION payhero_token_lookup(p_token text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT business_id FROM payment_settings WHERE callback_token = p_token
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['doc_counters','documents','document_lines','payments','suppliers','purchases','purchase_lines','payment_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid)$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kpos_app') THEN
    GRANT SELECT, INSERT, UPDATE ON doc_counters, documents, payments, suppliers, payment_settings TO kpos_app;
    GRANT SELECT, INSERT ON document_lines, purchases, purchase_lines TO kpos_app;
    GRANT EXECUTE ON FUNCTION payhero_token_lookup(text) TO kpos_app;
  END IF;
END $$;
