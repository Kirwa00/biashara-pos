import { type Cents, roundCents } from "./money";

/** KRA eTIMS tax types: A exempt, B 16% standard, C 0% export, D non-VAT, E 8% (petroleum). Verify against current KRA codes. */
export const TAX_CODES = {
  A: { label: "Exempt", rateBp: 0 },
  B: { label: "VAT 16%", rateBp: 1600 },
  C: { label: "Zero-rated", rateBp: 0 },
  D: { label: "Non-VAT", rateBp: 0 },
  E: { label: "VAT 8%", rateBp: 800 },
} as const;
export type TaxCode = keyof typeof TAX_CODES;

export interface LineInput {
  unitPriceCents: Cents;
  quantity: number;
  discountCents?: Cents;
  taxCode: TaxCode;
  priceIncludesTax: boolean;
}

export interface LineTotals {
  grossCents: Cents;
  netCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
}

/** Tax is computed and rounded per line; document totals are sums of line totals. */
export function computeLine(line: LineInput): LineTotals {
  if (line.quantity <= 0) throw new Error("Quantity must be positive");
  const gross = roundCents(line.unitPriceCents * line.quantity);
  const discount = line.discountCents ?? 0;
  if (discount < 0 || discount > gross) throw new Error("Invalid discount");
  const afterDiscount = gross - discount;
  const rateBp = TAX_CODES[line.taxCode].rateBp;
  let net: Cents;
  let tax: Cents;
  if (line.priceIncludesTax) {
    tax = roundCents((afterDiscount * rateBp) / (10000 + rateBp));
    net = afterDiscount - tax;
  } else {
    net = afterDiscount;
    tax = roundCents((net * rateBp) / 10000);
  }
  return { grossCents: gross, netCents: net, taxCents: tax, totalCents: net + tax };
}

export function computeDocument(lines: readonly LineInput[]) {
  const computed = lines.map(computeLine);
  const sum = (k: keyof LineTotals) => computed.reduce((a, l) => a + l[k], 0);
  return { lines: computed, netCents: sum("netCents"), taxCents: sum("taxCents"), totalCents: sum("totalCents") };
}
