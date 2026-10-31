import { api, ApiError, session } from "./api";

/** Prototype offline support: a per-business outbox of till sales, replayed with their idempotency keys. */
type Queued = { key: string; body: unknown; queuedAt: string; error?: string };

const claims = (): { bid: string; sub: string } => {
  try {
    return JSON.parse(atob(session.get()!.accessToken.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return { bid: "anon", sub: "anon" };
  }
};
// Queued sales replay only under the cashier who took them (their branch and shift).
const outboxKey = () => `kpos.outbox.${claims().bid}.${claims().sub}`;
export const cacheKey = (name: string) => `kpos.cache.${claims().bid}.${name}`;
// Display-only for the checkout guard; replay always re-checks /shifts/current.
export const cashierCacheKey = (name: string) => `kpos.cache.${claims().bid}.${claims().sub}.${name}`;

export const readOutbox = (): Queued[] => JSON.parse(localStorage.getItem(outboxKey()) ?? "[]");
const write = (q: Queued[]) => localStorage.setItem(outboxKey(), JSON.stringify(q));

export const isOffline = (e: unknown) => e instanceof TypeError || !navigator.onLine;

export function queueSale(body: { idempotencyKey: string; expectedTotalCents: number }) {
  write([...readOutbox(), { key: body.idempotencyKey, body, queuedAt: new Date().toISOString() }]);
}

export const discardQueued = (key: string) => write(readOutbox().filter((q) => q.key !== key));

let flushing = false;
/**
 * Sends queued sales oldest-first, only while this cashier has an open shift (so takings land in a Z report).
 * Stops on a network/server error; a rejected sale (4xx, e.g. prices changed) stays with its error.
 */
export async function flushOutbox(): Promise<"ok" | "no-shift" | "offline"> {
  if (flushing || !readOutbox().some((q) => !q.error)) return "ok";
  flushing = true;
  try {
    const shift = await api<unknown>("/shifts/current").catch(() => undefined);
    if (shift === undefined) return "offline";
    if (!shift) return "no-shift";
    for (const q of readOutbox()) {
      if (q.error) continue;
      try {
        await api("/documents", { method: "POST", body: JSON.stringify(q.body) });
        write(readOutbox().filter((x) => x.key !== q.key));
      } catch (e) {
        if (e instanceof ApiError && e.status < 500) {
          write(readOutbox().map((x) => (x.key === q.key ? { ...x, error: e.message } : x)));
          continue;
        }
        return "offline";
      }
    }
    return "ok";
  } finally {
    flushing = false;
  }
}
