import { z } from "zod";

export const kenyanPhone = z.string().regex(/^(?:\+?254|0)(7|1)\d{8}$/, "Enter a valid Kenyan phone number");
export const kraPin = z.string().regex(/^[AP]\d{9}[A-Z]$/, "KRA PIN format: A123456789B");

export const registerSchema = z.object({
  businessName: z.string().min(2).max(120),
  ownerName: z.string().min(2).max(120),
  email: z.string().email(),
  phone: kenyanPhone,
  password: z.string().min(10, "Use at least 10 characters"),
  kraPin: kraPin.optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
export type LoginInput = z.infer<typeof loginSchema>;

export const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  role: z.enum(["MANAGER", "ACCOUNTANT", "CASHIER"]),
  password: z.string().min(10),
  pin: z.string().regex(/^\d{4}$/).optional(),
  branchId: z.string().uuid().optional(),
});

export const createBranchSchema = z.object({ name: z.string().min(2), code: z.string().min(2).max(12) });

const cents = z.number().int().nonnegative();
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalBarcode = z.preprocess(blankToUndefined, z.string().trim().min(4).max(40).optional());
const optionalUnitBarcode = z.preprocess(blankToUndefined, z.string().trim().optional());
const qty = z.number().positive();
export const TAX_CODE_VALUES = ["A", "B", "C", "D", "E"] as const;

export const productSchema = z.object({
  sku: z.string().trim().min(1).max(40),
  barcode: optionalBarcode,
  name: z.string().trim().min(2).max(160),
  categoryId: z.string().uuid().optional(),
  baseUnit: z.string().trim().min(1).max(12).default("pc"),
  taxCode: z.enum(TAX_CODE_VALUES).default("B"),
  priceIncludesTax: z.boolean().default(true),
  costCents: cents.default(0),
  retailPriceCents: cents,
  wholesalePriceCents: cents.optional(),
  wholesaleMinQty: qty.optional(),
  reorderLevel: z.number().nonnegative().default(0),
  trackStock: z.boolean().default(true),
  units: z.array(z.object({ unit: z.string().trim().min(1).max(12), factor: qty, priceCents: cents, barcode: optionalUnitBarcode })).default([]),
});
export type ProductInput = z.infer<typeof productSchema>;

export const customerSchema = z.object({
  name: z.string().trim().min(2).max(160),
  phone: kenyanPhone.optional(),
  email: z.string().email().optional(),
  kraPin: kraPin.optional(),
  address: z.string().max(300).optional(),
  priceTier: z.enum(["RETAIL", "WHOLESALE"]).default("RETAIL"),
  creditLimitCents: cents.default(0),
  paymentTermsDays: z.number().int().min(0).max(365).default(0),
});
export type CustomerInput = z.infer<typeof customerSchema>;
