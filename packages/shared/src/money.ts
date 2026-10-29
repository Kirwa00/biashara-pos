/** All money is integer cents (KES × 100). Never use floats for stored amounts. */
export type Cents = number;

export function toCents(kes: number | string): Cents {
  const s = typeof kes === "number" ? kes.toFixed(2) : kes.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Invalid amount: ${kes}`);
  const neg = s.startsWith("-");
  const [whole = "0", frac = ""] = s.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return neg ? -cents : cents;
}

export function formatKes(cents: Cents, opts: { symbol?: boolean } = {}): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-KE");
  const frac = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}${opts.symbol === false ? "" : "KSh "}${whole}.${frac}`;
}

/** Round half away from zero to whole cents. */
export function roundCents(value: number): Cents {
  return Math.sign(value) * Math.round(Math.abs(value) + Number.EPSILON);
}

export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce((a, b) => a + b, 0);
}
