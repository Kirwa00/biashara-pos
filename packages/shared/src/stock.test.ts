import { describe, expect, it } from "vitest";
import { isLowStock, weightedAvgCost } from "./stock";

describe("stock", () => {
  it("blends receipts into weighted-average cost", () => {
    expect(weightedAvgCost(10, 5000, 10, 7000)).toBe(6000);
    expect(weightedAvgCost(0, 5000, 4, 8000)).toBe(8000);
    expect(weightedAvgCost(-2, 5000, 4, 8000)).toBe(8000);
    expect(weightedAvgCost(10, 5000, -3, 9999)).toBe(5000);
  });
  it("flags low stock only when a reorder level is set", () => {
    expect(isLowStock(5, 5)).toBe(true);
    expect(isLowStock(6, 5)).toBe(false);
    expect(isLowStock(0, 0)).toBe(false);
  });
});
