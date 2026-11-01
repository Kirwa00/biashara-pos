import { formatKes } from "@kpos/shared";
import { useState } from "react";
import { api } from "../api";
import { Card, Note, useLoad, type Product } from "./ui";

type Branch = { id: string; name: string; code: string; is_active: boolean };
type Transfer = { id: string; number: number; status: string; from_branch: string; to_branch: string; note: string | null; lines: number; value_cents: string; short: boolean; created_at: string };
type Detail = Transfer & { lines: { product_id: string; name: string; sku: string; quantity: string; quantity_received: string | null }[] };

const TONE: Record<string, string> = { PENDING: "bg-amber-50 text-amber-800", IN_TRANSIT: "bg-sky-50 text-sky-700", RECEIVED: "bg-emerald-50 text-emerald-700", CANCELLED: "bg-surface text-muted" };

/** Move stock between branches: raise, send (leaves the source), receive (arrives at the destination; shortfalls recorded). */
export function TransfersPage() {
  const branches = useLoad<Branch[]>("/branches", []);
  const products = useLoad<Product[]>("/products", []);
  const list = useLoad<Transfer[]>("/transfers", []);
  const [msg, setMsg] = useState("");
  const [lines, setLines] = useState<{ productId: string; quantity: string }[]>([{ productId: "", quantity: "1" }]);
  const [open, setOpen] = useState<Detail | null>(null);
  const [received, setReceived] = useState<Record<string, string>>({});
  const active = branches.data.filter((b) => b.is_active);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); setMsg(ok); list.reload(); } catch (e) { setMsg((e as Error).message); }
  };
  const create = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    run(async () => {
      await api("/transfers", { method: "POST", body: JSON.stringify({ fromBranchId: f.from, toBranchId: f.to, note: f.note || undefined,
        lines: lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })) }) });
      setLines([{ productId: "", quantity: "1" }]);
    }, "Transfer raised. Send it when the goods leave.");
  };
  const show = async (id: string) => {
    const d = await api<Detail>(`/transfers/${id}`);
    setOpen(d);
    setReceived(Object.fromEntries(d.lines.map((l) => [l.product_id, String(Number(l.quantity))])));
  };
  const act = (id: string, step: "send" | "cancel" | "receive") =>
    run(async () => {
      const body = step === "receive" && open ? { lines: open.lines.map((l) => ({ productId: l.product_id, quantity: Number(received[l.product_id] ?? 0) })) } : {};
      await api(`/transfers/${id}/${step}`, { method: "POST", body: JSON.stringify(body) });
      setOpen(null);
    }, step === "send" ? "Sent: stock has left the source branch." : step === "receive" ? "Received into the destination branch." : "Transfer cancelled.");

  return (
    <div className="space-y-4">
      <Note msg={msg || list.msg} />
      {active.length < 2 ? (
        <Card title="Branch transfers"><p className="text-sm text-muted">Add a second branch in Team &amp; Branches to move stock between branches.</p></Card>
      ) : (
        <Card title="New transfer">
          <form onSubmit={create} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-sm">From<select name="from" required className="input mt-1">{active.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
              <label className="text-sm">To<select name="to" required defaultValue={active[1]?.id} className="input mt-1">{active.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
              <label className="text-sm">Note<input name="note" className="input mt-1" placeholder="Optional" /></label>
            </div>
            {lines.map((l, i) => (
              <div key={i} className="flex gap-2">
                <select value={l.productId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))} className="input flex-1">
                  <option value="">Choose product…</option>
                  {products.data.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
                </select>
                <input type="number" min="0.001" step="0.001" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} className="input w-28" />
              </div>
            ))}
            <div className="flex justify-between">
              <button type="button" onClick={() => setLines([...lines, { productId: "", quantity: "1" }])} className="text-sm font-semibold text-primary hover:underline">+ Add product</button>
              <button className="btn-primary px-4 text-sm">Raise transfer</button>
            </div>
          </form>
        </Card>
      )}

      {open && (
        <Card title={`Transfer #${open.number}: ${open.from_branch} → ${open.to_branch}`}>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">Product</th><th className="text-right">Sent</th><th className="text-right">Received</th></tr></thead>
            <tbody>
              {open.lines.map((l) => (
                <tr key={l.product_id} className="border-t border-line">
                  <td className="py-2">{l.name} <span className="text-xs text-muted">{l.sku}</span></td>
                  <td className="num text-right">{Number(l.quantity)}</td>
                  <td className="text-right">{open.status === "IN_TRANSIT"
                    ? <input type="number" min="0" step="0.001" value={received[l.product_id] ?? ""} onChange={(e) => setReceived({ ...received, [l.product_id]: e.target.value })} className="input ml-auto w-24 text-right" />
                    : <span className="num">{l.quantity_received == null ? "—" : Number(l.quantity_received)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => setOpen(null)} className="rounded-lg border border-line px-3 py-2 text-sm">Close</button>
            {open.status === "PENDING" && <button onClick={() => act(open.id, "cancel")} className="rounded-lg border border-line px-3 py-2 text-sm text-critical">Cancel</button>}
            {open.status === "PENDING" && <button onClick={() => act(open.id, "send")} className="btn-primary px-4 text-sm">Send</button>}
            {open.status === "IN_TRANSIT" && <button onClick={() => act(open.id, "receive")} className="btn-primary px-4 text-sm">Receive</button>}
          </div>
        </Card>
      )}

      <Card title="Transfers">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-2">#</th><th>Route</th><th>Status</th><th className="text-right">Lines</th><th className="text-right">Value at cost</th><th /></tr></thead>
            <tbody>
              {list.data.map((x) => (
                <tr key={x.id} className="border-t border-line">
                  <td className="num py-2 font-semibold">{x.number}</td>
                  <td>{x.from_branch} → {x.to_branch}{x.note && <p className="text-xs text-muted">{x.note}</p>}</td>
                  <td><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TONE[x.status]}`}>{x.status.replace("_", " ")}</span>{x.short && <span className="ml-1 text-xs font-semibold text-critical">short</span>}</td>
                  <td className="num text-right">{x.lines}</td>
                  <td className="num text-right">{x.status === "PENDING" || x.status === "CANCELLED" ? "—" : formatKes(Number(x.value_cents))}</td>
                  <td className="text-right"><button onClick={() => show(x.id)} className="text-xs font-semibold text-primary hover:underline">Open</button></td>
                </tr>
              ))}
              {!list.data.length && <tr><td colSpan={6} className="py-6 text-center text-muted">No transfers yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
