/**
 * Browser side of answer-ready notifications. Notifications are per device: each phone, tablet or
 * computer is turned on separately, from Account.
 */

export type PushSupport =
  /** Ready to turn on (or already on). */
  | "ok"
  /** iPhone or iPad in Safari: notifications only work from the home-screen app. */
  | "install"
  /** This browser can't do web notifications at all. */
  | "unsupported";

const isApple = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  const has = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (isApple() && !isStandalone()) return "install";
  return has ? "ok" : "unsupported";
}

const fromB64url = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const sameKey = (a: ArrayBuffer | null, b: Uint8Array) => !!a && new Uint8Array(a).every((x, i) => x === b[i]) && a.byteLength === b.length;

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(() => navigator.serviceWorker.ready);
}

/** Whether this device currently gets notifications. */
export async function pushIsOn(publicKey: string): Promise<boolean> {
  if (pushSupport() !== "ok" || Notification.permission !== "granted") return false;
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return false;
  // The server's key changed: this device needs turning on again.
  return sameKey(sub.options.applicationServerKey, fromB64url(publicKey));
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const what = /iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    ? "iPad"
    : /iPhone/.test(ua)
      ? "iPhone"
      : /Android/.test(ua)
        ? "Android"
        : /Mac/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : "Computer";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : "Safari";
  return `${what} · ${browser}`;
}

/** Asks permission (must follow a tap), subscribes and tells the server. Returns an error to show, or null. */
export async function turnPushOn(publicKey: string): Promise<string | null> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "blocked";
  const reg = await registration();
  const key = fromB64url(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON();
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, device: deviceName() }),
  });
  if (!res.ok) return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't turn notifications on.";
  return null;
}

export async function turnPushOff(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await fetch("/api/push/subscribe", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

/**
 * Marks an answer being written as "left before it finished" (or clears the mark on return), so
 * the server knows to send a notification. keepalive lets it go out as the app is put away.
 */
export function markAway(requestId: string, away: boolean): void {
  fetch("/api/push/away", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, away }),
    keepalive: true,
  }).catch(() => {});
}
