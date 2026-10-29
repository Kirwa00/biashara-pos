import type { Cents } from "./money";

export const roundQty = (q: number) => Math.round(q * 1000) / 1000;

/** Weighted-average unit cost after receiving `qty` at `unitCost`. Negative/zero on-hand resets to the new cost. */
export function weightedAvgCost(onHand: number, avgCost: Cents, qty: number, unitCost: Cents): Cents {
  if (qty <= 0) return avgCost;
  if (onHand <= 0) return unitCost;
  return Math.round((onHand * avgCost + qty * unitCost) / (onHand + qty));
}

export const isLowStock = (onHand: number, reorderLevel: number) => reorderLevel > 0 && onHand <= reorderLevel;
