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
