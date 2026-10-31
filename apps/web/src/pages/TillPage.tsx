import { computeLine, formatKes, toCents, unitPrice, type TaxCode } from "@kpos/shared";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { cacheKey, cashierCacheKey, discardQueued, flushOutbox, isOffline, queueSale, readOutbox } from "../offline";
import { Note, useLoad, type Customer, type Product } from "./ui";

type Shift = {
  id: string;
  opened_at: string;
  expected_cash_cents: number;
  by_method: { method: string; amount_cents: string }[];
};

type CartLine = {
  product: Product;
  quantity: number;
};

type TenderMode = "CASH" | "MPESA_STK" | "MPESA_CODE" | "CARD" | "CREDIT";

export function TillPage() {
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("ALL");
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  
  // Tenders
  const [tenderMode, setTenderMode] = useState<TenderMode>("CASH");
  const [cashTendered, setCashTendered] = useState<string>("");
  const [mpesaCode, setMpesaCode] = useState<string>("");
  const [mpesaPhone, setMpesaPhone] = useState<string>("");
  const [cardRef, setCardRef] = useState<string>("");
  
  // Status & Confirmation
  const [msg, setMsg] = useState("");
  const [isCharging, setIsCharging] = useState(false);
  const [lastSale, setLastSale] = useState<{ id: string; number: number; total_cents: string; change_cents: number } | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Data
  const products = useLoad<Product[]>(`/products?limit=500${search ? `&q=${encodeURIComponent(search)}` : ""}`, [], search ? undefined : cacheKey("products"));
  const customers = useLoad<Customer[]>("/customers", [], cacheKey("customers"));
  const shift = useLoad<Shift | null>("/shifts/current", null, cashierCacheKey("shift"));

  // Offline outbox: retry on mount, when the browser comes back online, and every 20s.
  const [outbox, setOutbox] = useState(readOutbox);
  const [syncNote, setSyncNote] = useState("");
  const sync = () =>
    flushOutbox().then((r) => {
      setOutbox(readOutbox());
      setSyncNote(r === "no-shift" ? "Open a shift to sync these sales." : r === "offline" ? "Still offline; will retry." : "");
    });
  useEffect(() => {
    sync();
    window.addEventListener("online", sync);
    const t = setInterval(sync, 20_000);
    return () => { window.removeEventListener("online", sync); clearInterval(t); };
  }, []);

  // After an STK prompt, poll the payment until PayHero's callback confirms or fails it (~2 min).
  const pollStk = async (paymentId: string, phone: string) => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const p = await api<{ status: string; reference: string | null }>(`/payments/${paymentId}`).catch(() => null);
      if (p?.status === "CONFIRMED") { setMsg(`M-Pesa payment received from ${phone} (${p.reference}).`); shift.reload(); return; }
      if (p?.status === "FAILED") { setMsg(`M-Pesa prompt to ${phone} failed or was cancelled. The sale is unpaid: take another payment method.`); return; }
    }
    setMsg(`No M-Pesa confirmation from ${phone} after 2 minutes. Check the customer's phone, or record the M-Pesa code on the invoice.`);
  };

  // Auto-focus search input on mount
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // Add product to cart
  const addToCart = (product: Product) => {
    setCart((current) => {
      const idx = current.findIndex((item) => item.product.id === product.id);
      if (idx >= 0) {
        return current.map((item, i) =>
          i === idx ? { ...item, quantity: item.quantity + 1 } : item
        );
      }
      return [...current, { product, quantity: 1 }];
    });
  };

  // Adjust quantity
  const updateQuantity = (productId: string, delta: number) => {
    setCart((current) =>
      current
        .map((item) =>
          item.product.id === productId
            ? { ...item, quantity: Math.max(0, item.quantity + delta) }
            : item
        )
        .filter((item) => item.quantity > 0)
    );
  };

  const removeLine = (productId: string) => {
    setCart((current) => current.filter((item) => item.product.id !== productId));
  };

  // Barcode / Enter key handling
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && products.data.length > 0) {
      e.preventDefault();
      // If exact SKU or barcode match, or first search result
      const match = products.data.find(
        (p) => p.sku.toLowerCase() === search.trim().toLowerCase()
      ) || products.data[0];
      
      if (match) {
        addToCart(match);
        setSearch("");
      }
    }
  };

  // Price calculation
  const getLinePriceCents = (p: Product, qty: number) => {
    return unitPrice(
      {
        retailPriceCents: Number(p.retail_price_cents),
        wholesalePriceCents: p.wholesale_price_cents == null ? null : Number(p.wholesale_price_cents),
        wholesaleMinQty: p.wholesale_min_qty == null ? null : Number(p.wholesale_min_qty),
      },
      qty
    );
  };

  const getLineTotals = ({ product: p, quantity }: CartLine) => {
    return computeLine({
      quantity,
      taxCode: p.tax_code as TaxCode,
      priceIncludesTax: p.price_includes_tax,
      unitPriceCents: getLinePriceCents(p, quantity),
    });
  };

  const cartTotalCents = cart.reduce((sum, line) => sum + getLineTotals(line).totalCents, 0);
  const cartTaxCents = cart.reduce((sum, line) => sum + getLineTotals(line).taxCents, 0);
  const cartNetCents = cartTotalCents - cartTaxCents;

  // Cash change calculation
  const cashGivenCents = cashTendered ? toCents(cashTendered) : 0;
  const changeDueCents = tenderMode === "CASH" && cashGivenCents > cartTotalCents
    ? cashGivenCents - cartTotalCents
    : 0;

  // Process Checkout
  async function handleCheckout() {
    if (!cart.length) return;
    if (!shift.data) {
      setMsg("Cannot complete sale: no open till shift. Please open a shift first.");
      return;
    }

    setIsCharging(true);
    setMsg("");

    try {
      let payments: { method: string; amountCents: number; reference?: string }[] = [];

      if (tenderMode === "CASH") {
        payments = [{ method: "CASH", amountCents: cartTotalCents }];
      } else if (tenderMode === "MPESA_CODE") {
        if (!mpesaCode.trim()) throw new Error("Please enter the M-Pesa transaction code");
        payments = [{ method: "MPESA", amountCents: cartTotalCents, reference: mpesaCode.trim().toUpperCase() }];
      } else if (tenderMode === "CARD") {
        payments = [{ method: "CARD", amountCents: cartTotalCents, reference: cardRef.trim() || undefined }];
      } else if (tenderMode === "CREDIT") {
        if (!selectedCustomer) throw new Error("Please select a registered customer for credit sales");
        payments = []; // Unpaid invoice / credit sale
      }

      if (tenderMode === "MPESA_STK" && !mpesaPhone.trim()) throw new Error("Please enter phone number for M-Pesa STK Push");
      const body = {
        type: tenderMode === "CREDIT" ? "INVOICE" : "SALE",
        idempotencyKey: crypto.randomUUID(),
        customerId: selectedCustomer?.id || undefined,
        lines: cart.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
        payments,
      };
      let doc: { id: string; number: number; total_cents: string };
      try {
        doc = await api<typeof doc>("/documents", { method: "POST", body: JSON.stringify(body) });
      } catch (err) {
        // Cash and card sales can be taken offline; M-Pesa and credit need the server to verify.
        if (!isOffline(err) || (tenderMode !== "CASH" && tenderMode !== "CARD")) throw err;
        queueSale({ ...body, expectedTotalCents: cartTotalCents });
        setOutbox(readOutbox());
        setLastSale(null);
        setCart([]);
        setCashTendered("");
        setCardRef("");
        setMsg(`Offline: sale saved on this device and will sync automatically.${changeDueCents > 0 ? ` Change due ${formatKes(changeDueCents)}.` : ""}`);
        return;
      }

      // M-Pesa takes whole shillings; any cents remain on the invoice for another tender.
      if (tenderMode === "MPESA_STK") {
        const phone = mpesaPhone.trim();
        const { paymentId } = await api<{ paymentId: string }>("/payments/stk", {
          method: "POST",
          body: JSON.stringify({ documentId: doc.id, phone, amountCents: Math.floor(cartTotalCents / 100) * 100 }),
        });
        setMsg(`M-Pesa prompt sent to ${phone}. Waiting for the customer to enter their PIN…`);
        void pollStk(paymentId, phone);
      }

      setLastSale({
        id: doc.id,
        number: doc.number,
        total_cents: doc.total_cents,
        change_cents: changeDueCents,
      });

      // Clear Cart & Tenders
      setCart([]);
      setCashTendered("");
      setMpesaCode("");
      setCardRef("");
      shift.reload();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setIsCharging(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 xl:flex-row min-h-[calc(100vh-8rem)]">
      {/* LEFT CANVAS: Products Catalog & Fast Scanner (60%) */}
      <div className="flex flex-1 flex-col space-y-4 min-w-0">
        {/* Active Shift Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-card p-3 shadow-xs">
          {shift.data ? (
            <>
              <div className="flex items-center gap-2 text-sm">
                <span className="h-2.5 w-2.5 rounded-full bg-primary animate-pulse" />
                <span className="font-medium text-ink">
                  Shift Open · Cash Expected: <strong className="num text-primary font-bold">{formatKes(shift.data.expected_cash_cents)}</strong>
                </span>
              </div>
              <Link to="/shifts" className="text-xs font-semibold text-primary hover:underline">
                Manage Shift / Z-Reading →
              </Link>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm text-warning font-medium">
                <span>⚠️ No till shift open. Open a shift to record cash takings.</span>
              </div>
              <Link to="/shifts" className="btn-primary text-xs h-8 px-3">
                Open Shift Now
              </Link>
            </>
          )}
        </div>

        {outbox.length > 0 && (
          <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-ink">
                {outbox.filter((q) => !q.error).length} offline sale(s) waiting to sync {syncNote && <span className="text-muted">· {syncNote}</span>}
              </span>
              <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={sync}>
                Sync now
              </button>
            </div>
            {outbox.filter((q) => q.error).map((q) => (
              <div key={q.key} className="mt-2 flex items-center justify-between gap-3 text-xs text-critical">
                <span>Sale saved {new Date(q.queuedAt).toLocaleString()} was rejected: {q.error}</span>
                <button type="button" className="font-semibold hover:underline" onClick={() => { discardQueued(q.key); setOutbox(readOutbox()); }}>
                  Discard
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Search & Barcode Scan Bar */}
        <div className="relative">
          <input
            ref={searchInputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Scan barcode or type product name / SKU (Press Enter)..."
            className="input pr-10 text-base font-medium shadow-xs"
          />
          {search && (
            <button
              onClick={() => {
                setSearch("");
                searchInputRef.current?.focus();
              }}
              className="absolute right-3 top-3 text-muted hover:text-ink text-sm"
            >
              ✕
            </button>
          )}
        </div>

        {/* Product Grid */}
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {products.data.map((p) => {
              const inCart = cart.find((item) => item.product.id === p.id);
              const price = Number(p.retail_price_cents);
              return (
                <button
                  key={p.id}
                  onClick={() => addToCart(p)}
                  className={`relative flex flex-col justify-between rounded-xl border p-3.5 text-left transition hover:border-primary hover:shadow-sm ${
                    inCart ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-line bg-card"
                  }`}
                >
                  {inCart && (
                    <span className="absolute -top-2 -right-2 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-white shadow-xs">
                      {inCart.quantity}
                    </span>
                  )}
                  <div>
                    <span className="font-mono text-[11px] uppercase tracking-wider text-muted">{p.sku}</span>
                    <h3 className="line-clamp-2 mt-0.5 text-sm font-semibold text-ink leading-tight">
                      {p.name}
                    </h3>
                  </div>
                  <div className="mt-3 flex items-baseline justify-between">
                    <span className="num font-display text-base font-bold text-ink">
                      {formatKes(price)}
                    </span>
                    <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-bold text-muted">
                      VAT [{p.tax_code}]
                    </span>
                  </div>
                </button>
              );
            })}
            {products.data.length === 0 && (
              <div className="col-span-full py-12 text-center text-muted">
                No matching products found. Scan a valid barcode or add items in Products.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* RIGHT PANEL: Fixed Cart Slip & Checkout Dock (40% - min 380px) */}
      <div className="w-full xl:w-[420px] shrink-0 flex flex-col rounded-2xl border border-line bg-card shadow-sm overflow-hidden">
        {/* Customer Selector Header */}
        <div className="border-b border-line bg-surface/50 p-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-bold uppercase tracking-wider text-muted">Customer Account</span>
            {selectedCustomer && (
              <button
                onClick={() => setSelectedCustomer(null)}
                className="text-xs text-muted hover:text-ink"
              >
                Reset to Walk-in
              </button>
            )}
          </div>
          <select
            value={selectedCustomer?.id || ""}
            onChange={(e) => {
              const c = customers.data.find((cust) => cust.id === e.target.value);
              setSelectedCustomer(c || null);
            }}
            className="input h-10 text-sm"
          >
            <option value="">Walk-in Customer (Standard Retail)</option>
            {customers.data.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* Cart Itemized Lines */}
        <div className="flex-1 overflow-y-auto p-4 divide-y divide-line">
          {cart.map((line) => {
            const totals = getLineTotals(line);
            return (
              <div key={line.product.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">{line.product.name}</p>
                    <p className="num text-xs text-muted">
                      {formatKes(getLinePriceCents(line.product, line.quantity))} × {line.quantity}
                    </p>
                  </div>
                  <span className="num font-semibold text-sm text-ink">{formatKes(totals.totalCents)}</span>
                </div>

                <div className="mt-2 flex items-center justify-between">
                  <div className="flex items-center rounded-lg border border-line bg-surface">
                    <button
                      onClick={() => updateQuantity(line.product.id, -1)}
                      className="px-2.5 py-1 text-sm font-bold text-muted hover:text-ink"
                    >
                      -
                    </button>
                    <span className="num px-2 text-xs font-bold">{line.quantity}</span>
                    <button
                      onClick={() => updateQuantity(line.product.id, 1)}
                      className="px-2.5 py-1 text-sm font-bold text-muted hover:text-ink"
                    >
                      +
                    </button>
                  </div>
                  <button
                    onClick={() => removeLine(line.product.id)}
                    className="text-xs text-critical hover:underline"
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          })}

          {cart.length === 0 && (
            <div className="py-16 text-center text-muted">
              <p className="text-sm font-medium">Cart is empty</p>
              <p className="text-xs mt-1">Scan an item or click a product tile to begin checkout</p>
            </div>
          )}
        </div>

        {/* Cart Totals & Checkout Tenders */}
        <div className="border-t border-line bg-surface/30 p-4 space-y-4">
          <Note msg={msg} />

          {/* Last Sale Confirmation Banner */}
          {lastSale && (
            <div className="rounded-xl border border-primary/30 bg-primary/10 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-bold text-primary">Sale #{lastSale.number} Completed!</span>
                <a
                  href={`/receipt/${lastSale.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded bg-primary px-2.5 py-1 text-xs font-bold text-white hover:bg-primary-active"
                >
                  Print Receipt
                </a>
              </div>
              {lastSale.change_cents > 0 && (
                <p className="mt-1 font-semibold text-ink">
                  Change Due: <span className="num font-bold text-primary">{formatKes(lastSale.change_cents)}</span>
                </p>
              )}
            </div>
          )}

          {/* Totals Breakdown */}
          <div className="space-y-1.5 text-xs text-muted">
            <div className="flex justify-between">
              <span>Taxable Net</span>
              <span className="num">{formatKes(cartNetCents)}</span>
            </div>
            <div className="flex justify-between">
              <span>16% Output VAT</span>
              <span className="num">{formatKes(cartTaxCents)}</span>
            </div>
            <div className="flex justify-between pt-1 text-base font-bold text-ink border-t border-line">
              <span>Grand Total</span>
              <span className="num text-xl font-display text-primary">{formatKes(cartTotalCents)}</span>
            </div>
          </div>

          {/* Tender Mode Selector */}
          <div className="grid grid-cols-4 gap-1.5 rounded-lg border border-line bg-card p-1 text-xs font-semibold">
            <button
              onClick={() => setTenderMode("CASH")}
              className={`rounded py-1.5 transition ${tenderMode === "CASH" ? "bg-navy text-white shadow-xs" : "text-muted hover:text-ink"}`}
            >
              Cash
            </button>
            <button
              onClick={() => setTenderMode("MPESA_CODE")}
              className={`rounded py-1.5 transition ${tenderMode === "MPESA_CODE" ? "bg-navy text-white shadow-xs" : "text-muted hover:text-ink"}`}
            >
              M-Pesa
            </button>
            <button
              onClick={() => setTenderMode("MPESA_STK")}
              className={`rounded py-1.5 transition ${tenderMode === "MPESA_STK" ? "bg-navy text-white shadow-xs" : "text-muted hover:text-ink"}`}
            >
              STK Push
            </button>
            <button
              onClick={() => setTenderMode("CREDIT")}
              className={`rounded py-1.5 transition ${tenderMode === "CREDIT" ? "bg-navy text-white shadow-xs" : "text-muted hover:text-ink"}`}
            >
              Credit
            </button>
          </div>

          {/* Tender-Specific Inputs */}
          {tenderMode === "CASH" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted font-medium">Cash Given:</span>
                {changeDueCents > 0 && (
                  <span className="font-bold text-primary">Change: {formatKes(changeDueCents)}</span>
                )}
              </div>
              <input
                type="number"
                step="1"
                placeholder={`e.g. ${Math.ceil(cartTotalCents / 100) || 500}`}
                value={cashTendered}
                onChange={(e) => setCashTendered(e.target.value)}
                className="input font-display text-lg"
              />
              {/* Quick Cash Buttons */}
              <div className="grid grid-cols-4 gap-1.5 text-xs font-semibold">
                {[100, 500, 1000, 2000].map((note) => (
                  <button
                    key={note}
                    onClick={() => setCashTendered(String(note))}
                    className="rounded border border-line bg-surface py-1 hover:bg-line"
                  >
                    KES {note}
                  </button>
                ))}
              </div>
            </div>
          )}

          {tenderMode === "MPESA_CODE" && (
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase text-muted">M-Pesa Transaction Code</label>
              <input
                value={mpesaCode}
                onChange={(e) => setMpesaCode(e.target.value.toUpperCase())}
                placeholder="e.g. TBD829X10Q"
                className="input font-mono uppercase text-base"
              />
              <p className="mt-1 text-[11px] text-muted">Verified directly against PayHero API on checkout</p>
            </div>
          )}

          {tenderMode === "MPESA_STK" && (
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase text-muted">Customer M-Pesa Phone</label>
              <input
                value={mpesaPhone}
                onChange={(e) => setMpesaPhone(e.target.value)}
                placeholder="0712345678"
                className="input text-base"
              />
              <p className="mt-1 text-[11px] text-muted">Customer receives PIN prompt on their phone</p>
            </div>
          )}

          {tenderMode === "CREDIT" && (
            <div className="rounded-lg bg-surface p-2.5 text-xs text-muted">
              {selectedCustomer ? (
                <p>
                  Charging to <strong className="text-ink">{selectedCustomer.name}</strong> account. An unpaid tax invoice will be generated.
                </p>
              ) : (
                <p className="text-critical font-medium">Please select a customer from the dropdown above to allow credit sale.</p>
              )}
            </div>
          )}

          {/* Complete Charge Button */}
          <button
            onClick={handleCheckout}
            disabled={!cart.length || isCharging || (tenderMode === "CREDIT" && !selectedCustomer)}
            className="btn-primary w-full py-3.5 text-base font-bold shadow-md"
          >
            {isCharging ? "Processing Sale…" : `Charge ${formatKes(cartTotalCents)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
