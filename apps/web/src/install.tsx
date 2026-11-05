import { useEffect, useState } from "react";

type Offer = { prompt: () => Promise<void>; userChoice?: Promise<{ outcome: string }> };

// Chrome fires this once, soon after load, usually before anyone has signed in, so listen from the start.
let offer: Offer | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); offer = e as unknown as Offer; changed(); });
window.addEventListener("appinstalled", () => { offer = null; changed(); });

const installed = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isPhone = () => isIos() || /android|mobile/i.test(navigator.userAgent);

/** Install button, or the manual steps where the browser gives no prompt (always on iPhone). Hidden once installed, and on computers with no offer. */
export function InstallApp({ className = "", tone = "light" }: { className?: string; tone?: "light" | "dark" }) {
  const [, redraw] = useState(0);
  const [steps, setSteps] = useState(false);
  useEffect(() => {
    const l = () => redraw((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  if (installed() || (!offer && !isPhone())) return null;

  const install = async () => {
    if (!offer) return setSteps(!steps);
    await offer.prompt();
    await offer.userChoice?.catch(() => {});
    offer = null;
    changed();
  };
  const hint = tone === "dark" ? "text-slate-300" : "text-muted";
  return (
    <div className={className}>
      <button type="button" onClick={install} aria-expanded={offer ? undefined : steps} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary-active">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M4 20h16" /></svg>
        Install the app
      </button>
      {steps && !offer && (
        <p className={`mt-2 text-sm ${hint}`}>
          {isIos()
            ? <>In Safari, tap <strong>Share</strong> (the square with an arrow), then <strong>Add to Home Screen</strong>.</>
            : <>Open your browser menu (<strong>⋮</strong>), then tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.</>}
        </p>
      )}
    </div>
  );
}
