import { api, ApiError, session } from "./api";

/** Prototype offline support: a per-business outbox of till sales, replayed with their idempotency keys. */
type Queued = { key: string; body: unknown; queuedAt: string; error?: string };

export const businessId = (): string => {
  try {
    return (JSON.parse(atob(session.get()!.accessToken.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { bid: string }).bid;
  } catch {
    return "anon";
  }
};
const outboxKey = () => `kpos.outbox.${businessId()}`;
export const cacheKey = (name: string) => `kpos.cache.${businessId()}.${name}`;

export const readOutbox = (): Queued[] => JSON.parse(localStorage.getItem(outboxKey()) ?? "[]");
const write = (q: Queued[]) => localStorage.setItem(outboxKey(), JSON.stringify(q));

export const isOffline = (e: unknown) => e instanceof TypeError || !navigator.onLine;

export function queueSale(body: { idempotencyKey: string }) {
  write([...readOutbox(), { key: body.idempotencyKey, body, queuedAt: new Date().toISOString() }]);
}

export const discardQueued = (key: string) => write(readOutbox().filter((q) => q.key !== key));

let flushing = false;
/** Sends queued sales oldest-first. Stops on a network/server error; a rejected sale (4xx) stays with its error. */
export async function flushOutbox(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
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
        return;
      }
    }
  } finally {
    flushing = false;
  }
}
