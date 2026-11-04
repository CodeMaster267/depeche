import "server-only";
import { createECDH, hkdfSync } from "node:crypto";
import webpush from "web-push";
import { serviceRoleKey } from "@/lib/config";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Web Push, the free notification service built into every browser (Apple, Google, Mozilla and
 * Microsoft run the delivery). Nothing here costs money or needs an account.
 *
 * Each push is signed with a "VAPID" key pair. Like the provider-key encryption, the pair is derived
 * from the Supabase secret key that already lives in Vercel, so there is nothing to set up.
 * VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Vercel override it if ever wanted.
 * Messages are encrypted for the receiving device, so the push service can't read them.
 */
const b64url = (b: Buffer) => b.toString("base64url");

export function vapidKeys(): { publicKey: string; privateKey: string } | null {
  const pub = process.env.VAPID_PUBLIC_KEY?.trim();
  const priv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (pub && priv) return { publicKey: pub, privateKey: priv };
  const base = serviceRoleKey();
  if (!base) return null;
  // 32 random-looking bytes make a valid P-256 private key (the chance one is out of range is ~2^-32).
  const secret = Buffer.from(hkdfSync("sha256", base, "depeche", "web-push vapid v1", 32));
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(secret);
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(secret) };
}

/** True when pushes are only pretend: local browser tests with the fake AI (refused on Vercel). */
const testing = () => process.env.DEPECHE_FAKE_AI === "1" && !process.env.VERCEL;

/** The push services browsers use. The server only ever sends to these. */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, // Chrome, Edge on Android, Samsung
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^web\.push\.apple\.com$/, // Safari and iPhone/iPad home-screen apps
  /^[a-z0-9-]+\.notify\.windows\.com$/, // Edge on Windows
];

export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  // The browser tests receive pushes on a little local server.
  if (testing() && url.protocol === "http:" && url.hostname === "127.0.0.1") return true;
  return url.protocol === "https:" && !url.port && PUSH_HOSTS.some((h) => h.test(url.hostname));
}

export type PushNote = { title: string; body: string; url: string; tag?: string };

/**
 * Sends a note to every device where this person turned notifications on. Devices that have
 * switched them off since (the push service says the address is gone) are forgotten.
 */
export async function pushTo(ownerId: string, note: PushNote): Promise<number> {
  const keys = vapidKeys();
  if (!keys) return 0;
  const admin = supabaseAdmin();
  const { data } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("owner_id", ownerId)
    .returns<{ id: string; endpoint: string; p256dh: string; auth: string }[]>();
  const subs = (data ?? []).filter((s) => isPushEndpoint(s.endpoint));
  const subject = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || "depai.vercel.app"}`;
  const payload = JSON.stringify(note);
  let sent = 0;
  const gone: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        // web-push signs and encrypts; the request itself goes out with fetch.
        const req = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
          vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          // Kept by the push service for up to a day if the device is off.
          TTL: 24 * 60 * 60,
          urgency: "high",
          topic: note.tag?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined,
        });
        // fetch works out the length itself.
        const headers = Object.fromEntries(
          Object.entries(req.headers as Record<string, string | number>)
            .filter(([k]) => k.toLowerCase() !== "content-length")
            .map(([k, v]) => [k, String(v)]),
        );
        const res = await fetch(req.endpoint, {
          method: req.method,
          headers,
          body: req.body ? new Uint8Array(req.body) : undefined,
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        });
        if (res.status === 404 || res.status === 410) gone.push(s.id);
        else if (res.ok) sent++;
      } catch {
        // Unreachable this time; try again with the next answer.
      }
    }),
  );
  if (gone.length) await admin.from("push_subscriptions").delete().in("id", gone);
  return sent;
}
