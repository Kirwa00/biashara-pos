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

const stockQty = z.number().finite().refine((n) => Math.abs(n) <= 1e9 && Math.round(n * 1000) === n * 1000, "Max 3 decimals");
export const openingStockSchema = z.object({
  branchId: z.string().uuid().optional(),
  lines: z.array(z.object({ productId: z.string().uuid(), quantity: stockQty.refine((n) => n > 0, "Must be positive"), unitCostCents: cents })).min(1).max(5000),
});
export const stockAdjustmentSchema = z.object({
  branchId: z.string().uuid().optional(),
  productId: z.string().uuid(),
  quantity: stockQty.refine((n) => n !== 0, "Cannot be zero"),
  reason: z.string().trim().min(3).max(200),
});
export const stockCountSchema = z.object({
  branchId: z.string().uuid().optional(),
  note: z.string().trim().max(200).optional(),
  lines: z.array(z.object({ productId: z.string().uuid(), counted: stockQty.refine((n) => n >= 0, "Cannot be negative") })).min(1).max(5000),
});

const docLine = z.object({ productId: z.string().uuid(), quantity: stockQty.refine((n) => n > 0, "Must be positive") });
export const PAYMENT_METHODS = ["CASH", "MPESA", "CARD", "BANK"] as const;
export const paymentInputSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amountCents: z.number().int().positive(),
  reference: z.string().trim().min(3).max(40).optional(),
}).refine((p) => p.method === "CASH" || !!p.reference, { message: "Enter the transaction code", path: ["reference"] });
export const documentSchema = z.object({
  type: z.enum(["QUOTE", "INVOICE", "SALE"]),
  branchId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  dueDays: z.number().int().min(0).max(365).optional(),
  idempotencyKey: z.string().min(8).max(64).optional(),
  lines: z.array(docLine).min(1).max(500),
  payments: z.array(paymentInputSchema).max(5).default([]),
});
export const supplierSchema = z.object({
  name: z.string().trim().min(2).max(160),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().email().optional(),
  kraPin: z.string().trim().toUpperCase().regex(/^[AP]\d{9}[A-Z]$/, "Invalid KRA PIN").optional(),
});
export const purchaseSchema = z.object({
  supplierId: z.string().uuid(),
  branchId: z.string().uuid().optional(),
  supplierRef: z.string().trim().max(60).optional(),
  lines: z.array(z.object({ productId: z.string().uuid(), quantity: stockQty.refine((n) => n > 0, "Must be positive"), unitCostCents: cents })).min(1).max(500),
});
export const paymentSettingsSchema = z.object({
  username: z.string().trim().min(3).max(120),
  password: z.string().min(3).max(200),
  channelId: z.number().int().positive(),
});
export const stkPushSchema = z.object({
  documentId: z.string().uuid(),
  phone: z.string().trim().regex(/^(?:\+?254|0)[17]\d{8}$/, "Invalid phone"),
  amountCents: z.number().int().positive().refine((n) => n % 100 === 0, "M-Pesa takes whole shillings"),
});
