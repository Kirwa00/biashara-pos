import { useState } from "react";
import { api } from "../api";
import { Card, formData, Note, useLoad } from "./ui";

type Settings = { configured: boolean; username?: string; channelId?: number; callbackUrl?: string };

export function PaymentsSettingsPage() {
  const s = useLoad<Settings>("/settings/payments", { configured: false });
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="grid max-w-3xl gap-6">
      <Card title="PayHero M-Pesa">
        <Note msg={s.msg} />
        <p className="mb-4 text-sm text-muted">{s.data.configured ? `Connected as ${s.data.username} (channel ${s.data.channelId}). The password is stored encrypted and never shown.` : "Enter the API username, password and channel ID from your PayHero dashboard."}</p>
        {s.data.callbackUrl && <p className="mb-4 break-all rounded-lg bg-surface p-3 text-xs">Callback URL: {s.data.callbackUrl}</p>}
        <form className="space-y-3" onSubmit={async (e) => {
          const form = e.currentTarget;
          const f = formData(e);
          setSaving(true);
          setResult(null);
          try {
            await api("/settings/payments", { method: "PUT", body: JSON.stringify({ username: f.username, password: f.password, channelId: Number(f.channelId) }) });
            await s.reload();
            form.reset();
            setResult({ ok: true, text: "Saved. Your PayHero details are stored; a real M-Pesa payment will confirm they work." });
          } catch (err) {
            setResult({ ok: false, text: `Not saved: ${(err as Error).message}` });
          } finally {
            setSaving(false);
          }
        }}>
          <input name="username" placeholder="API username" defaultValue={s.data.username} required className="input" />
          <input name="password" type="password" placeholder={s.data.configured ? "API password (enter it again to save changes)" : "API password"} required className="input" autoComplete="new-password" />
          <input name="channelId" placeholder="Channel ID (numbers only)" inputMode="numeric" pattern="[0-9]+" title="Numbers only" defaultValue={s.data.channelId} required className="input" />
          <button disabled={saving} className="btn-primary w-full disabled:opacity-60">{saving ? "Saving…" : "Save PayHero details"}</button>
          {result && <p role="status" className={`rounded-lg p-3 text-sm ${result.ok ? "bg-surface" : "bg-surface font-semibold text-critical"}`}>{result.text}</p>}
        </form>
      </Card>
    </div>
  );
}
