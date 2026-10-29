import { describe, expect, it } from "vitest";
import { computeDocument, computeLine, formatKes, toCents, can } from "./index";

describe("money", () => {
  it("parses KES to cents exactly", () => {
    expect(toCents("1350")).toBe(135000);
    expect(toCents("0.1")).toBe(10);
    expect(toCents(19.99)).toBe(1999);
    expect(() => toCents("1.234")).toThrow();
  });
  it("formats", () => expect(formatKes(250000)).toBe("KSh 2,500.00"));
});

describe("tax", () => {
  it("extracts 16% VAT from inclusive price (design cart: KSh 2,500)", () => {
    const doc = computeDocument([
      { unitPriceCents: 16500, quantity: 2, taxCode: "B", priceIncludesTax: true },
      { unitPriceCents: 82000, quantity: 1, taxCode: "B", priceIncludesTax: true },
      { unitPriceCents: 135000, quantity: 1, taxCode: "B", priceIncludesTax: true },
    ]);
    expect(doc.totalCents).toBe(250000);
    expect(doc.netCents + doc.taxCents).toBe(doc.totalCents);
    expect(doc.taxCents).toBe(34483);
  });
  it("adds VAT to exclusive price", () => {
    expect(computeLine({ unitPriceCents: 10000, quantity: 1, taxCode: "B", priceIncludesTax: false }).totalCents).toBe(11600);
  });
  it("exempt has no tax and discount reduces net", () => {
    const l = computeLine({ unitPriceCents: 10000, quantity: 3, discountCents: 500, taxCode: "A", priceIncludesTax: true });
    expect(l).toEqual({ grossCents: 30000, netCents: 29500, taxCents: 0, totalCents: 29500 });
  });
});

describe("permissions", () => {
  it("cashier cannot adjust stock or override discounts", () => {
    expect(can("CASHIER", "sales.create")).toBe(true);
    expect(can("CASHIER", "stock.adjust")).toBe(false);
    expect(can("CASHIER", "sales.discount.override")).toBe(false);
    expect(can("OWNER", "settings.payments")).toBe(true);
    expect(can("MANAGER", "settings.payments")).toBe(false);
  });
});
