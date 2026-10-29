const KEY = "kpos.session";
type Session = { accessToken: string; refreshToken: string };

export const session = {
  get: (): Session | null => JSON.parse(localStorage.getItem(KEY) ?? "null"),
  set: (s: Session) => localStorage.setItem(KEY, JSON.stringify(s)),
  clear: () => localStorage.removeItem(KEY),
};

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function refresh(): Promise<boolean> {
  const s = session.get();
  if (!s) return false;
  const res = await fetch("/v1/auth/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: s.refreshToken }) });
  if (!res.ok) { session.clear(); return false; }
  session.set(await res.json());
  return true;
}

export async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const token = session.get()?.accessToken;
  const res = await fetch(`/v1${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  if (res.status === 401 && retry && (await refresh())) return api<T>(path, init, false);
  if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
  return (res.status === 204 ? undefined : await res.json()) as T;
}
