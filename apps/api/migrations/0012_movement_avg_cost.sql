-- Average cost after each movement, so stock can be valued as at any past date. Older rows fall back to unit_cost_cents.
ALTER TABLE stock_movements ADD COLUMN avg_cost_after bigint;
