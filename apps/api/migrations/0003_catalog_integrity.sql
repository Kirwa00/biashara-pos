-- Review fixes: tenant-safe foreign keys and barcode uniqueness across products and pack units.
-- Clean up data the old schema allowed so the constraints below can be created.
UPDATE products SET barcode = NULL WHERE btrim(barcode) = '';
UPDATE product_units SET barcode = NULL WHERE btrim(barcode) = '';
-- A unit pointing at another tenant's product is corrupt; drop it rather than expose it to that tenant.
DELETE FROM product_units u USING products p WHERE p.id = u.product_id AND u.business_id <> p.business_id;
UPDATE products p SET category_id = NULL FROM categories c WHERE c.id = p.category_id AND c.business_id <> p.business_id;
UPDATE users u SET branch_id = NULL FROM branches b WHERE b.id = u.branch_id AND b.business_id <> u.business_id;
UPDATE product_units u SET barcode = NULL WHERE EXISTS (
  SELECT 1 FROM products p WHERE p.business_id = u.business_id AND p.barcode = u.barcode);
UPDATE product_units u SET barcode = NULL WHERE u.barcode IS NOT NULL AND EXISTS (
  SELECT 1 FROM product_units o WHERE o.business_id = u.business_id AND o.barcode = u.barcode AND o.id < u.id);

ALTER TABLE branches ADD CONSTRAINT branches_business_id_uq UNIQUE (business_id, id);
ALTER TABLE categories ADD CONSTRAINT categories_business_id_uq UNIQUE (business_id, id);
ALTER TABLE products ADD CONSTRAINT products_business_id_uq UNIQUE (business_id, id);

ALTER TABLE users DROP CONSTRAINT users_branch_id_fkey,
  ADD CONSTRAINT users_branch_fk FOREIGN KEY (business_id, branch_id) REFERENCES branches (business_id, id);
ALTER TABLE products DROP CONSTRAINT products_category_id_fkey,
  ADD CONSTRAINT products_category_fk FOREIGN KEY (business_id, category_id) REFERENCES categories (business_id, id);
ALTER TABLE product_units DROP CONSTRAINT product_units_product_id_fkey,
  ADD CONSTRAINT product_units_product_fk FOREIGN KEY (business_id, product_id) REFERENCES products (business_id, id) ON DELETE CASCADE;

CREATE UNIQUE INDEX product_units_barcode_uq ON product_units (business_id, barcode) WHERE barcode IS NOT NULL;

-- One barcode must resolve to exactly one product/unit per business.
-- SECURITY DEFINER (migration owner) so RLS can't hide conflicting rows from the check.
CREATE FUNCTION check_barcode_unique() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.barcode IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.business_id::text || ':' || NEW.barcode));
  IF TG_TABLE_NAME = 'products' THEN
    IF EXISTS (SELECT 1 FROM product_units WHERE business_id = NEW.business_id AND barcode = NEW.barcode) THEN
      RAISE EXCEPTION 'Barcode % is already used by a pack unit', NEW.barcode USING ERRCODE = 'unique_violation';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM products WHERE business_id = NEW.business_id AND barcode = NEW.barcode) THEN
    RAISE EXCEPTION 'Barcode % is already used by a product', NEW.barcode USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER products_barcode_unique BEFORE INSERT OR UPDATE OF barcode ON products FOR EACH ROW EXECUTE FUNCTION check_barcode_unique();
CREATE TRIGGER product_units_barcode_unique BEFORE INSERT OR UPDATE OF barcode ON product_units FOR EACH ROW EXECUTE FUNCTION check_barcode_unique();
ALTER TABLE products ADD CONSTRAINT products_barcode_not_blank CHECK (btrim(barcode) <> '');
ALTER TABLE product_units ADD CONSTRAINT product_units_barcode_not_blank CHECK (btrim(barcode) <> '');
