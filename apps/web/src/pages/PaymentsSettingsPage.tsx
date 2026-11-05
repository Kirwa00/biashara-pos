import { formatKes } from "@kpos/shared";
import { useState } from "react";
import { api } from "../api";
import { Card, formData, Note, useLoad } from "./ui";

type Settings = { configured: boolean; username?: string | null; channelId?: number; callbackUrl?: string };
type Check = { ok: boolean; message?: string; channel?: { id: number; description: string | null; shortCode: string | null }; walletBalanceCents?: number | null };
type Result = { ok: boolean; text: string; warn?: string };

/** What PayHero confirmed, plus a warning if the service wallet is empty. The docs don't state a minimum, so this warns rather than blocks. */
const describe = (c: Check, lead: string): Result => {
  const name = [c.channel?.description, c.channel?.shortCode].filter(Boolean).join(", ");
  const wallet = c.walletBalanceCents;
  return {
    ok: true,
    text: `${lead} Channel ${c.channel?.id}${name ? ` (${name})` : ""}.${wallet == null ? "" : ` Service wallet: ${formatKes(wallet)}.`}`,
    warn: wallet != null && wallet <= 0 ? "Your PayHero service wallet is empty. If prompts don't arrive, top it up in PayHero." : undefined,
  };
};

export function PaymentsSettingsPage() {
  const s = useLoad<Settings>("/settings/payments", { configured: false });
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const test = async () => {
    setBusy("test");
    setResult(null);
    try {
      const c = await api<Check>("/settings/payments/test", { method: "POST", body: "{}" });
      setResult(c.ok ? describe(c, "Connected to PayHero.") : { ok: false, text: c.message ?? "PayHero did not accept these details." });
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid max-w-3xl gap-6">
      <Card title="PayHero M-Pesa">
        <Note msg={s.msg} />
        <p className="mb-4 text-sm text-muted">
          {s.data.configured
            ? `Saved for channel ${s.data.channelId}${s.data.username ? ` (signed in as ${s.data.username})` : ""}. Your token is stored encrypted and never shown.`
            : "Connect your PayHero account so the till can send M-Pesa prompts."}
        </p>
        <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>In your PayHero dashboard, open <strong>API Keys</strong>, then <strong>Add new API Key</strong>.</li>
          <li>Copy the <strong>Basic Authorization</strong> token and paste it below.</li>
          <li>Find your channel ID under <strong>Payment Channels</strong>, then <strong>My Payment Channels</strong>.</li>
        </ol>
        <form className="space-y-3" onSubmit={async (e) => {
          const form = e.currentTarget;
          const f = formData(e);
          setBusy("save");
          setResult(null);
          try {
            const c = await api<Check>("/settings/payments", { method: "PUT", body: JSON.stringify({ token: f.token, channelId: Number(f.channelId) }) });
            await s.reload();
            form.reset();
            setResult(describe(c, "Saved and connected to PayHero."));
          } catch (err) {
            setResult({ ok: false, text: `Not saved: ${(err as Error).message}` });
          } finally {
            setBusy(null);
          }
        }}>
          <label className="block text-sm font-medium">PayHero Basic Authorization token
            <input name="token" type="password" required autoComplete="off" spellCheck={false} placeholder={s.data.configured ? "Paste again to replace the saved token" : "Paste your token"} className="input mt-1 font-normal" />
          </label>
          <label className="block text-sm font-medium">Channel ID
            <input key={s.data.channelId} name="channelId" inputMode="numeric" pattern="[0-9]+" title="Numbers only" defaultValue={s.data.channelId} required className="input mt-1 font-normal" />
          </label>
          <button disabled={!!busy} className="btn-primary w-full disabled:opacity-60">{busy === "save" ? "Checking with PayHero…" : "Check and save"}</button>
          {s.data.configured && (
            <button type="button" onClick={test} disabled={!!busy} className="min-h-12 w-full rounded-lg border border-line font-semibold hover:bg-surface disabled:opacity-60">
              {busy === "test" ? "Testing…" : "Test saved connection"}
            </button>
          )}
          {result && (
            <div role="status" className={`rounded-lg bg-surface p-3 text-sm ${result.ok ? "" : "font-semibold text-critical"}`}>
              <p>{result.text}</p>
              {result.warn && <p className="mt-1 font-semibold text-warning">{result.warn}</p>}
            </div>
          )}
          <p className="text-xs text-muted">Checking only reads your account; it sends no M-Pesa prompt and takes no money.</p>
        </form>
        {s.data.callbackUrl && <p className="mt-4 break-all rounded-lg bg-surface p-3 text-xs text-muted">Callback URL (sent to PayHero automatically): {s.data.callbackUrl}</p>}
      </Card>
    </div>
  );
}
