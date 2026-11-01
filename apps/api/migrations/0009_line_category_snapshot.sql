-- Category at time of sale, so category reports don't shift when a product is re-categorised.
ALTER TABLE document_lines ADD COLUMN category_id uuid;
UPDATE document_lines l SET category_id = p.category_id FROM products p WHERE p.id = l.product_id AND l.category_id IS NULL;
