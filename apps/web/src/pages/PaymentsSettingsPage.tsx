import { api } from "../api";
import { Card, formData, Note, useLoad } from "./ui";

type Settings = { configured: boolean; username?: string; channelId?: number; callbackUrl?: string };

export function PaymentsSettingsPage() {
  const s = useLoad<Settings>("/settings/payments", { configured: false });
  return (
    <div className="grid max-w-3xl gap-6">
      <Card title="PayHero M-Pesa">
        <Note msg={s.msg} />
        <p className="mb-4 text-sm text-muted">{s.data.configured ? `Connected as ${s.data.username} (channel ${s.data.channelId}). The password is stored encrypted and never shown.` : "Enter the API username, password and channel ID from your PayHero dashboard."}</p>
        {s.data.callbackUrl && <p className="mb-4 break-all rounded-lg bg-surface p-3 text-xs">Callback URL: {s.data.callbackUrl}</p>}
        <form className="space-y-3" onSubmit={async (e) => { const f = formData(e); try { await api("/settings/payments", { method: "PUT", body: JSON.stringify({ username: f.username, password: f.password, channelId: Number(f.channelId) }) }); s.setMsg("Saved"); s.reload(); } catch (err) { s.setMsg((err as Error).message); } }}>
          <input name="username" placeholder="API username" defaultValue={s.data.username} required className="input" />
          <input name="password" type="password" placeholder="API password" required className="input" autoComplete="new-password" />
          <input name="channelId" placeholder="Channel ID" inputMode="numeric" required className="input" />
          <button className="btn-primary w-full">Save PayHero details</button>
        </form>
      </Card>
    </div>
  );
}
