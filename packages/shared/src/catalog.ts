import type { Cents } from "./money";
import { toCents } from "./money";
import { TAX_CODES, type TaxCode } from "./tax";

export interface PricedProduct {
  retailPriceCents: Cents;
  wholesalePriceCents?: Cents | null;
  wholesaleMinQty?: number | null;
}

/** Wholesale price applies to wholesale customers, or to anyone buying at least wholesaleMinQty. */
export function unitPrice(p: PricedProduct, qty: number, tier: "RETAIL" | "WHOLESALE" = "RETAIL"): Cents {
  if (p.wholesalePriceCents == null) return p.retailPriceCents;
  if (tier === "WHOLESALE") return p.wholesalePriceCents;
  if (p.wholesaleMinQty != null && qty >= p.wholesaleMinQty) return p.wholesalePriceCents;
  return p.retailPriceCents;
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

/** CSV columns: sku,name,category,barcode,unit,tax_code,retail_price,wholesale_price,wholesale_min_qty,cost,reorder_level (prices in KES). */
export function csvRowToProduct(r: Record<string, string>) {
  const taxCode = (r.tax_code || "B").toUpperCase();
  if (!(taxCode in TAX_CODES)) throw new Error(`Unknown tax_code ${taxCode}`);
  const num = (v?: string) => (v ? Number(v) : undefined);
  return {
    sku: r.sku ?? "",
    name: r.name ?? "",
    category: r.category || undefined,
    barcode: r.barcode || undefined,
    baseUnit: r.unit || "pc",
    taxCode: taxCode as TaxCode,
    retailPriceCents: toCents(r.retail_price || "0"),
    wholesalePriceCents: r.wholesale_price ? toCents(r.wholesale_price) : undefined,
    wholesaleMinQty: num(r.wholesale_min_qty),
    costCents: r.cost ? toCents(r.cost) : 0,
    reorderLevel: num(r.reorder_level) ?? 0,
  };
}
