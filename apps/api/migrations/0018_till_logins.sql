-- Till logins: the owner gives a teller a username and PIN, used with the shop's code. Usernames only need to be unique within a shop.

-- A volatile default gives every existing business its own code without touching RLS.
ALTER TABLE businesses ADD COLUMN shop_code text NOT NULL DEFAULT upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
CREATE UNIQUE INDEX businesses_shop_code_uq ON businesses (shop_code);

ALTER TABLE users
  ADD COLUMN username text,
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN password_hash DROP NOT NULL,
  -- Everyone signs in one way or the other. A PIN never opens the back office, so a till login must stay a cashier.
  ADD CONSTRAINT users_login_ck CHECK (
    (email IS NOT NULL AND password_hash IS NOT NULL AND username IS NULL)
    OR (username IS NOT NULL AND pin_hash IS NOT NULL AND email IS NULL AND role = 'CASHIER')
  );
CREATE UNIQUE INDEX users_username_uq ON users (business_id, lower(username)) WHERE username IS NOT NULL;

-- Sign-in must find the teller before the tenant is known; expose only that lookup, as with auth_lookup.
CREATE FUNCTION till_lookup(p_code text, p_username text) RETURNS TABLE (id uuid, business_id uuid, pin_hash text, role text, is_active boolean, locked_until timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.business_id, u.pin_hash, u.role, u.is_active, u.locked_until
  FROM users u JOIN businesses b ON b.id = u.business_id
  WHERE b.shop_code = upper(p_code) AND lower(u.username) = lower(p_username)
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kpos_app') THEN
    GRANT EXECUTE ON FUNCTION till_lookup(text, text) TO kpos_app;
  END IF;
END $$;
