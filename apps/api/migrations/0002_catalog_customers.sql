-- Sprint 1: catalog (categories, products, units of measure, price tiers) and customers.
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_name_uq ON categories (business_id, lower(name));

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  category_id uuid REFERENCES categories(id),
  sku text NOT NULL,
  barcode text,
  name text NOT NULL,
  base_unit text NOT NULL DEFAULT 'pc',
  tax_code char(1) NOT NULL DEFAULT 'B' CHECK (tax_code IN ('A','B','C','D','E')),
  price_includes_tax boolean NOT NULL DEFAULT true,
  cost_cents bigint NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  retail_price_cents bigint NOT NULL CHECK (retail_price_cents >= 0),
  wholesale_price_cents bigint CHECK (wholesale_price_cents >= 0),
  wholesale_min_qty numeric(12,3),
  reorder_level numeric(12,3) NOT NULL DEFAULT 0,
  track_stock boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  etims_item_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, sku)
);
CREATE UNIQUE INDEX products_barcode_uq ON products (business_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX products_name_idx ON products (business_id, lower(name));

-- Pack sizes, e.g. 1 carton = 24 pc, each with its own price.
CREATE TABLE product_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  unit text NOT NULL,
  factor numeric(12,3) NOT NULL CHECK (factor > 0),
  price_cents bigint NOT NULL CHECK (price_cents >= 0),
  barcode text,
  UNIQUE (product_id, unit)
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  name text NOT NULL,
  phone text,
  email text,
  kra_pin text,
  address text,
  price_tier text NOT NULL DEFAULT 'RETAIL' CHECK (price_tier IN ('RETAIL','WHOLESALE')),
  credit_limit_cents bigint NOT NULL DEFAULT 0 CHECK (credit_limit_cents >= 0),
  payment_terms_days int NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_name_idx ON customers (business_id, lower(name));
CREATE UNIQUE INDEX customers_phone_uq ON customers (business_id, phone) WHERE phone IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['categories','products','product_units','customers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid)$p$, t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kpos_app') THEN
    GRANT SELECT, INSERT, UPDATE ON categories, products, customers TO kpos_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON product_units TO kpos_app;
  END IF;
END $$;
