import { describe, expect, it } from "vitest";
import { billingState, planCaps, planSku } from "./billing";

const at = (iso: string) => new Date(iso);

describe("billingState", () => {
  const trial_ends_at = "2026-11-15T12:00:00Z";
  it("is a trial until the trial ends, counting days down", () => {
    expect(billingState({ trial_ends_at }, at("2026-11-08T12:00:00Z"))).toMatchObject({ kind: "TRIAL", daysLeft: 7 });
    expect(billingState({ trial_ends_at }, at("2026-11-15T11:00:00Z"))).toMatchObject({ kind: "TRIAL", daysLeft: 1 });
  });
  it("gives exactly three days of grace, then lapses", () => {
    expect(billingState({ trial_ends_at }, at("2026-11-15T12:00:00Z")).kind).toBe("GRACE");
    expect(billingState({ trial_ends_at }, at("2026-11-18T12:00:00Z")).kind).toBe("GRACE");
    expect(billingState({ trial_ends_at }, at("2026-11-18T12:00:01Z")).kind).toBe("LAPSED");
  });
  it("is active once paid, and whichever end is later counts", () => {
    expect(billingState({ trial_ends_at, paid_until: "2026-12-15T12:00:00Z" }, at("2026-11-10T00:00:00Z")).kind).toBe("ACTIVE");
    expect(billingState({ trial_ends_at: "2026-01-01T00:00:00Z", paid_until: "2026-11-01T00:00:00Z" }, at("2026-11-02T00:00:00Z")).kind).toBe("GRACE");
    expect(billingState({ trial_ends_at: "2026-01-01T00:00:00Z", paid_until: "2026-11-01T00:00:00Z" }, at("2026-11-10T00:00:00Z")).kind).toBe("LAPSED");
  });
});

describe("plans", () => {
  it("trials get Commercial limits; Enterprise is unlimited", () => {
    expect(planCaps(null).branches).toBe(5);
    expect(planCaps("STARTER")).toMatchObject({ branches: 1, products: 1000 });
    expect(planCaps("ENTERPRISE").branches).toBeNull();
  });
  it("names the catalog SKU for each plan and cycle", () => {
    expect(planSku("STARTER", "ANNUAL")).toBe("PLAN-STARTER-ANNUAL");
  });
});
