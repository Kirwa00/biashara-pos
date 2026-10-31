-- An M-Pesa code can settle only one payment per business (hand-entered or STK-confirmed).
-- Existing codes are upper-cased; older case-only duplicates (e.g. qk123 vs QK123) keep the first and get a -DUPn suffix so the index can build.
UPDATE payments SET reference = upper(reference) WHERE method = 'MPESA' AND reference IS NOT NULL AND reference <> upper(reference)
  AND NOT EXISTS (SELECT 1 FROM payments o WHERE o.business_id = payments.business_id AND o.method = 'MPESA' AND o.id <> payments.id AND upper(o.reference) = upper(payments.reference));
UPDATE payments p SET reference = p.reference || '-DUP' || d.n
  FROM (SELECT id, row_number() OVER (PARTITION BY business_id, upper(reference) ORDER BY created_at, id) - 1 AS n
        FROM payments WHERE method = 'MPESA' AND direction = 1 AND status <> 'FAILED' AND reference IS NOT NULL) d
  WHERE p.id = d.id AND d.n > 0;
CREATE UNIQUE INDEX payments_mpesa_code_uq ON payments (business_id, upper(reference))
  WHERE method = 'MPESA' AND direction = 1 AND status <> 'FAILED' AND reference IS NOT NULL;
