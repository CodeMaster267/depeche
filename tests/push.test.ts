import { afterEach, describe, expect, it, vi } from "vitest";
import { createECDH } from "node:crypto";

vi.mock("server-only", () => ({}));
const { isPushEndpoint, vapidKeys } = await import("@/lib/push/server");

afterEach(() => vi.unstubAllEnvs());

describe("push addresses", () => {
  it("accepts the browsers' real push services", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://web.push.apple.com/QH9x",
      "https://updates.push.services.mozilla.com/wpush/v2/x",
      "https://wns2-bl2p.notify.windows.com/w/?token=x",
    ]) expect(isPushEndpoint(ok), ok).toBe(true);
  });

  it("refuses anything else, so the server can't be pointed elsewhere", () => {
    for (const bad of [
      "http://fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://evil.example/fcm.googleapis.com",
      "https://fcm.googleapis.com.evil.example/x",
      "https://127.0.0.1/x",
      "http://127.0.0.1:9999/x",
      "not a url",
    ]) expect(isPushEndpoint(bad), bad).toBe(false);
  });

  it("allows a local test receiver only with the fake AI, never on Vercel", () => {
    vi.stubEnv("DEPECHE_FAKE_AI", "1");
    expect(isPushEndpoint("http://127.0.0.1:9999/x")).toBe(true);
    vi.stubEnv("VERCEL", "1");
    expect(isPushEndpoint("http://127.0.0.1:9999/x")).toBe(false);
  });
});

describe("signing keys", () => {
  it("are derived from the Supabase secret key, steady, and a valid P-256 pair", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_example");
    const a = vapidKeys()!;
    expect(vapidKeys()).toEqual(a);
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(a.privateKey, "base64url"));
    expect(ecdh.getPublicKey().toString("base64url")).toBe(a.publicKey);
    expect(Buffer.from(a.publicKey, "base64url")).toHaveLength(65);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "another");
    expect(vapidKeys()!.publicKey).not.toBe(a.publicKey);
  });

  it("can be set in Vercel instead", () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "pub");
    vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
    expect(vapidKeys()).toEqual({ publicKey: "pub", privateKey: "priv" });
  });
});
