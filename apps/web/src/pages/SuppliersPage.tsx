import { formatKes, toCents } from "@kpos/shared";
import { useState } from "react";
import { api } from "../api";
import { Card, Note, ProductSelect, useLoad, type Product } from "./ui";

type Supplier = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  kra_pin: string | null;
};

type Purchase = {
  id: string;
  number: number;
  supplier_name: string;
  supplier_ref: string | null;
  total_cents: string;
  created_at: string;
};

export function SuppliersPage() {
  const suppliers = useLoad<Supplier[]>("/suppliers", []);
  const purchases = useLoad<Purchase[]>("/purchases", []);
  const products = useLoad<Product[]>("/products?limit=500", []);

  // Form State
  const [supplierId, setSupplierId] = useState("");
  const [supplierRef, setSupplierRef] = useState("");
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");

  const [newSupName, setNewSupName] = useState("");
  const [newSupPhone, setNewSupPhone] = useState("");
  const [newSupEmail, setNewSupEmail] = useState("");
  const [newSupKraPin, setNewSupKraPin] = useState("");

  const [msg, setMsg] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleReceiveStock(e: React.FormEvent) {
    e.preventDefault();
    if (!supplierId || !productId || !quantity || !unitCost) {
      setMsg("Please fill in all receiving fields.");
      return;
    }

    setIsSubmitting(true);
    setMsg("");
    try {
      const res = await api<{ number: number; total_cents: string }>("/purchases", {
        method: "POST",
        body: JSON.stringify({
          supplierId,
          supplierRef: supplierRef || undefined,
          lines: [
            {
              productId,
              quantity: Number(quantity),
              unitCostCents: toCents(unitCost),
            },
          ],
        }),
      });

      setMsg(`GRN #${res.number} received. Stock ledger and average cost updated.`);
      setProductId("");
      setQuantity("");
      setUnitCost("");
      setSupplierRef("");
      purchases.reload();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleAddSupplier(e: React.FormEvent) {
    e.preventDefault();
    if (!newSupName.trim()) return;

    setIsSubmitting(true);
    setMsg("");
    try {
      await api("/suppliers", {
        method: "POST",
        body: JSON.stringify({
          name: newSupName.trim(),
          phone: newSupPhone.trim() || undefined,
          email: newSupEmail.trim() || undefined,
          kraPin: newSupKraPin.trim().toUpperCase() || undefined,
        }),
      });

      setMsg(`Supplier "${newSupName}" registered.`);
      setNewSupName("");
      setNewSupPhone("");
      setNewSupEmail("");
      setNewSupKraPin("");
      suppliers.reload();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }

  const totalProcurementCents = purchases.data.reduce(
    (sum, p) => sum + Number(p.total_cents),
    0
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold">Suppliers & Goods Receiving (GRN)</h1>
          <p className="text-sm text-muted">
            Vendor accounts, purchase intake, cost of goods receiving, and stock movement posting
          </p>
        </div>
        <div className="rounded-xl border border-line bg-card px-4 py-2 text-right">
          <span className="text-xs uppercase text-muted font-medium">Total Procurement Intake</span>
          <p className="num font-display text-xl font-bold text-primary">{formatKes(totalProcurementCents)}</p>
        </div>
      </div>

      <Note msg={msg || purchases.msg || suppliers.msg} />

      <div className="grid gap-6 xl:grid-cols-3">
        {/* GRN History Table (2 Cols) */}
        <Card title="Goods Received Notes (GRN Ledger)" className="xl:col-span-2">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-muted">
                <tr>
                  <th className="py-2.5">GRN #</th>
                  <th>Supplier</th>
                  <th>Invoice Ref</th>
                  <th>Received Date</th>
                  <th className="text-right">Total Cost</th>
                  <th className="text-right">Ledger Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {purchases.data.map((p) => (
                  <tr key={p.id} className="hover:bg-surface/50">
                    <td className="py-3 font-semibold text-ink">
                      GRN-{String(p.number).padStart(4, "0")}
                    </td>
                    <td className="font-medium">{p.supplier_name}</td>
                    <td className="font-mono text-xs">{p.supplier_ref ?? "—"}</td>
                    <td className="text-xs text-muted">{p.created_at.slice(0, 10)}</td>
                    <td className="num text-right font-bold">{formatKes(Number(p.total_cents))}</td>
                    <td className="text-right">
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
                        Stock Posted
                      </span>
                    </td>
                  </tr>
                ))}
                {purchases.data.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-muted">
                      No purchase intake records found. Receive stock using the form on the right.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Action Panels */}
        <div className="space-y-6">
          {/* Receive Stock Form */}
          <Card title="Receive Stock (Intake)">
            <form onSubmit={handleReceiveStock} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase text-muted">Supplier</label>
                <select
                  required
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                  className="input"
                >
                  <option value="">Select Vendor…</option>
                  {suppliers.data.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase text-muted">Product</label>
                <select
                  required
                  value={productId}
                  onChange={(e) => setProductId(e.target.value)}
                  className="input"
                >
                  <option value="">Select Product…</option>
                  {products.data.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.sku} — {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase text-muted">Intake Qty</label>
                  <input
                    type="number"
                    step="0.001"
                    min="0.001"
                    required
                    placeholder="e.g. 50"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    className="input font-bold"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase text-muted">Unit Cost (KES)</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    placeholder="KES 240.00"
                    value={unitCost}
                    onChange={(e) => setUnitCost(e.target.value)}
                    className="input font-bold"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase text-muted">
                  Supplier Delivery / Invoice Ref #
                </label>
                <input
                  placeholder="e.g. INV-99214"
                  value={supplierRef}
                  onChange={(e) => setSupplierRef(e.target.value)}
                  className="input font-mono"
                />
              </div>

              <p className="text-[11px] text-muted">
                Rule: Inventory increases and weighted average cost re-calculates automatically upon GRN intake.
              </p>

              <button
                type="submit"
                disabled={isSubmitting || !supplierId || !productId}
                className="btn-primary w-full"
              >
                {isSubmitting ? "Posting to Ledger…" : "Post Goods Intake (GRN)"}
              </button>
            </form>
          </Card>

          {/* Add Supplier Form */}
          <Card title="Register New Supplier">
            <form onSubmit={handleAddSupplier} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase text-muted">Company / Vendor Name</label>
                <input
                  required
                  placeholder="e.g. Unga Farm Care Ltd"
                  value={newSupName}
                  onChange={(e) => setNewSupName(e.target.value)}
                  className="input"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase text-muted">Phone</label>
                  <input
                    placeholder="07..."
                    value={newSupPhone}
                    onChange={(e) => setNewSupPhone(e.target.value)}
                    className="input"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase text-muted">KRA PIN</label>
                  <input
                    placeholder="P05..."
                    value={newSupKraPin}
                    onChange={(e) => setNewSupKraPin(e.target.value)}
                    className="input uppercase font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase text-muted">Email (Optional)</label>
                <input
                  type="email"
                  placeholder="sales@vendor.co.ke"
                  value={newSupEmail}
                  onChange={(e) => setNewSupEmail(e.target.value)}
                  className="input"
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting || !newSupName.trim()}
                className="rounded-lg border border-line bg-surface py-2.5 text-xs font-bold text-ink hover:bg-line transition w-full"
              >
                Save Supplier Account
              </button>
            </form>
          </Card>
        </div>
      </div>
    </div>
  );
}
