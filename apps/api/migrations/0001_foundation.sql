-- Sprint 0: tenancy, users, roles, audit. Every tenant table carries business_id and is RLS-protected.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kra_pin text,
  phone text,
  currency char(3) NOT NULL DEFAULT 'KES',
  timezone text NOT NULL DEFAULT 'Africa/Nairobi',
  status text NOT NULL DEFAULT 'TRIAL' CHECK (status IN ('TRIAL','ACTIVE','SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  name text NOT NULL,
  code text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, code)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  branch_id uuid REFERENCES branches(id),
  name text NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  pin_hash text,
  role text NOT NULL CHECK (role IN ('OWNER','MANAGER','ACCOUNTANT','CASHIER')),
  is_active boolean NOT NULL DEFAULT true,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE INDEX users_business_idx ON users (business_id);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

-- Append-only: the app role gets INSERT/SELECT only.
CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  user_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  before jsonb,
  after jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_business_created_idx ON audit_logs (business_id, created_at DESC);

-- Row-level security: the request sets app.business_id inside its transaction.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branches','users','refresh_tokens','audit_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON businesses USING (id = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK (true);

-- Login must find a user by email before the tenant is known; expose only that lookup.
CREATE FUNCTION auth_lookup(p_email text) RETURNS TABLE (id uuid, business_id uuid, password_hash text, role text, is_active boolean, locked_until timestamptz, name text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id, business_id, password_hash, role, is_active, locked_until, name FROM users WHERE lower(email) = lower(p_email)
$$;
CREATE FUNCTION refresh_lookup(p_hash text) RETURNS TABLE (id uuid, business_id uuid, user_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id, business_id, user_id FROM refresh_tokens WHERE token_hash = p_hash AND revoked_at IS NULL AND expires_at > now()
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kpos_app') THEN
    GRANT SELECT, INSERT, UPDATE ON businesses, branches, users, refresh_tokens TO kpos_app;
    GRANT SELECT, INSERT ON audit_logs TO kpos_app;
    GRANT EXECUTE ON FUNCTION auth_lookup(text), refresh_lookup(text) TO kpos_app;
  END IF;
END $$;
