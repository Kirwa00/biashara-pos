-- Gate 4 SaaS operations: platform admins (SUPER_ADMIN_EMAILS) list tenants, suspend/reactivate them and open read-only support views.

-- Platform-level log of what admins did; not tenant data, so no RLS. The target business also gets an audit_logs row.
CREATE TABLE admin_actions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_user_id uuid NOT NULL,
  admin_email text NOT NULL,
  action text NOT NULL,
  business_id uuid REFERENCES businesses(id),
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_actions_created_idx ON admin_actions (created_at DESC);

-- Tenant overview across RLS. Callable only through the admin routes, which check SUPER_ADMIN_EMAILS first.
CREATE FUNCTION admin_businesses() RETURNS TABLE (
  id uuid, name text, status text, phone text, kra_pin text, created_at timestamptz, owner_email text, owner_name text,
  users int, branches int, documents_30d int, sales_30d_cents bigint, last_activity timestamptz
)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT b.id, b.name, b.status, b.phone, b.kra_pin, b.created_at,
    (SELECT u.email FROM users u WHERE u.business_id = b.id AND u.role = 'OWNER' ORDER BY u.created_at LIMIT 1),
    (SELECT u.name FROM users u WHERE u.business_id = b.id AND u.role = 'OWNER' ORDER BY u.created_at LIMIT 1),
    (SELECT count(*)::int FROM users u WHERE u.business_id = b.id AND u.is_active),
    (SELECT count(*)::int FROM branches br WHERE br.business_id = b.id),
    (SELECT count(*)::int FROM documents d WHERE d.business_id = b.id AND d.type IN ('SALE','INVOICE') AND d.created_at > now() - interval '30 days'),
    (SELECT coalesce(sum(d.total_cents), 0)::bigint FROM documents d WHERE d.business_id = b.id AND d.type IN ('SALE','INVOICE') AND d.created_at > now() - interval '30 days'),
    (SELECT max(a.created_at) FROM audit_logs a WHERE a.business_id = b.id)
  FROM businesses b ORDER BY b.created_at DESC
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kpos_app') THEN
    GRANT SELECT, INSERT ON admin_actions TO kpos_app;
    GRANT EXECUTE ON FUNCTION admin_businesses() TO kpos_app;
  END IF;
END $$;
