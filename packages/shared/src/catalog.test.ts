import { describe, expect, it } from "vitest";
import { csvRowToProduct, parseCsv, unitPrice } from "./catalog";

describe("unitPrice", () => {
  const p = { retailPriceCents: 16500, wholesalePriceCents: 15000, wholesaleMinQty: 12 };
  it("uses retail below the wholesale quantity", () => expect(unitPrice(p, 11)).toBe(16500));
  it("uses wholesale at the threshold or for wholesale customers", () => {
    expect(unitPrice(p, 12)).toBe(15000);
    expect(unitPrice(p, 1, "WHOLESALE")).toBe(15000);
  });
  it("falls back to retail without a wholesale price", () => expect(unitPrice({ retailPriceCents: 100 }, 99, "WHOLESALE")).toBe(100));
});

describe("CSV import", () => {
  it("parses quoted fields and maps a product row", () => {
    const rows = parseCsv('SKU,Name,Category,Retail Price,Tax Code\r\nMLK-1,"Milk, 500ml",Dairy,65,B\n\nSGR-2,"Sugar ""Kabras"" 1kg",,180.50,A\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.name).toBe("Milk, 500ml");
    expect(csvRowToProduct(rows[1]!)).toMatchObject({ sku: "SGR-2", name: 'Sugar "Kabras" 1kg', retailPriceCents: 18050, taxCode: "A" });
  });
  it("rejects unknown tax codes", () => expect(() => csvRowToProduct({ sku: "x", name: "x", tax_code: "Z" })).toThrow());
});
