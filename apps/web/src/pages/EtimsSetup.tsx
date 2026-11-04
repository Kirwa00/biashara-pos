import { useState } from "react";
import { api } from "../api";
import { Card, formData, Note, useLoad } from "./ui";

type Settings = { configured: boolean; environment?: string; tin?: string; bhfId?: string; deviceSerial?: string; enabled?: boolean };
type Item = { id: string; sku: string; name: string; tax_code: string; etims_item_code: string | null; kra_item_class_code: string | null; kra_unit_code: string | null; kra_pkg_unit_code: string | null; mapped: boolean };

/** Owner-only OSCU device details from KRA onboarding. The communication key is write-only. */
export function EtimsSettingsCard({ onSaved }: { onSaved: () => void }) {
  const s = useLoad<Settings | null>("/settings/etims", null);
  const [msg, setMsg] = useState("");
  if (s.msg === "Not allowed") return null;
  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    const f = formData(e);
    try {
      await api("/settings/etims", { method: "PUT", body: JSON.stringify({ environment: f.environment, tin: f.tin, bhfId: f.bhfId, deviceSerial: f.deviceSerial, cmcKey: f.cmcKey, enabled: f.enabled === "on" }) });
      setMsg("eTIMS settings saved.");
      s.reload(); onSaved();
    } catch (err) { setMsg((err as Error).message); }
  };
  const d = s.data;
  return (
    <Card title="eTIMS device (OSCU)">
      <Note msg={msg} />
      <p className="mb-3 text-xs text-muted">Enter the details KRA issued when your OSCU device was registered. Start in Sandbox; switch to Production only after KRA certification.</p>
      <form key={d?.tin ?? "new"} onSubmit={save} className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">Environment
          <select name="environment" defaultValue={d?.environment ?? "SANDBOX"} className="input mt-1 w-full"><option value="SANDBOX">Sandbox</option><option value="PRODUCTION">Production</option></select>
        </label>
        <label className="text-sm">KRA PIN (TIN)<input name="tin" required defaultValue={d?.tin} placeholder="P051234567X" className="input mt-1 w-full" /></label>
        <label className="text-sm">Branch ID (bhfId)<input name="bhfId" required defaultValue={d?.bhfId ?? "00"} className="input mt-1 w-full" /></label>
        <label className="text-sm">Device serial<input name="deviceSerial" required defaultValue={d?.deviceSerial} className="input mt-1 w-full" /></label>
        <label className="text-sm sm:col-span-2">Communication key (cmcKey)<input name="cmcKey" type="password" required placeholder={d?.configured ? "Saved — re-enter to change settings" : ""} className="input mt-1 w-full" /></label>
        <label className="flex items-center gap-2 text-sm"><input name="enabled" type="checkbox" defaultChecked={d?.enabled} /> Submit documents to KRA</label>
        <div className="sm:text-right"><button className="btn-primary h-10 px-4 text-sm">Save</button></div>
      </form>
    </Card>
  );
}

/** Products need a registered KRA item code and classification before their sales can be submitted. */
export function EtimsItemCodes() {
  const items = useLoad<Item[]>("/etims/items", []);
  const [msg, setMsg] = useState("");
  const [showAll, setShowAll] = useState(false);
  if (items.msg === "Not allowed") return null;
  const save = async (e: React.FormEvent<HTMLFormElement>, id: string) => {
    const f = formData(e);
    try {
      await api(`/etims/items/${id}`, { method: "PUT", body: JSON.stringify({ itemCode: f.itemCode, itemClassCode: f.itemClassCode, unitCode: f.unitCode || "U", pkgUnitCode: f.pkgUnitCode || "NT" }) });
      setMsg("KRA codes saved.");
      items.reload();
    } catch (err) { setMsg((err as Error).message); }
  };
  const unmapped = items.data.filter((i) => !i.mapped).length;
  const shown = showAll ? items.data : items.data.filter((i) => !i.mapped);
  return (
    <Card title={`KRA item codes · ${unmapped} unmapped`}>
      <Note msg={msg || items.msg} />
      <button onClick={() => setShowAll(!showAll)} className="mb-3 text-xs font-semibold text-primary hover:underline">{showAll ? "Show unmapped only" : "Show all products"}</button>
      <div className="space-y-2">
        {shown.slice(0, 100).map((i) => (
          <form key={i.id} onSubmit={(e) => save(e, i.id)} className="grid items-end gap-2 rounded-lg border border-line p-3 text-sm sm:grid-cols-6">
            <div className="sm:col-span-2"><p className="font-medium">{i.name}</p><p className="text-xs text-muted">{i.sku} · tax {i.tax_code}</p></div>
            <input name="itemCode" required defaultValue={i.etims_item_code ?? ""} placeholder="Item code" className="input" />
            <input name="itemClassCode" required defaultValue={i.kra_item_class_code ?? ""} placeholder="Class code" className="input" />
            <div className="flex gap-2"><input name="unitCode" defaultValue={i.kra_unit_code ?? "U"} className="input w-14" /><input name="pkgUnitCode" defaultValue={i.kra_pkg_unit_code ?? "NT"} className="input w-14" /></div>
            <button className="btn-primary h-9 px-3 text-xs">Save</button>
          </form>
        ))}
        {!shown.length && <p className="py-4 text-center text-sm text-muted">Every product has KRA codes.</p>}
      </div>
    </Card>
  );
}
