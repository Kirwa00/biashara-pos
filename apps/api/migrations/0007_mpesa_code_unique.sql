-- An M-Pesa code can settle only one payment per business (hand-entered or STK-confirmed).
CREATE UNIQUE INDEX payments_mpesa_code_uq ON payments (business_id, upper(reference))
  WHERE method = 'MPESA' AND direction = 1 AND status <> 'FAILED' AND reference IS NOT NULL;
