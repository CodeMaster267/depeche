import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { checkPasskey, grantUnlock, isUnlocked, lockSession, revokeUnlock, tryPin, unlockOptions, type Assertion } from "@/lib/lock/server";

/**
 * The lock screen talks to these. They work while the app is locked (the proxy lets /api/lock/
 * through), but every one needs a signed-in person.
 *
 *   POST pin      { pin }          unlock with the PIN
 *   POST options                   a challenge for Face ID / Touch ID
 *   POST passkey  { assertion }    unlock with Face ID / Touch ID
 *   POST touch                     the page is in use: keep it unlocked (answers whether it's locked)
 *   POST lock                      lock now (the page was left, or the timer ran out)
 *   POST signout                   forgot the PIN: sign out on this device (signing back in unlocks)
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const s = await lockSession();
  if (!s) return NextResponse.json({ error: "Sign in again.", signedOut: true }, { status: 401 });
  if (action === "signout") {
    await (await supabaseServer()).auth.signOut({ scope: "local" });
    return NextResponse.json({ ok: true });
  }
  if (!s.meta) return NextResponse.json({ ok: true, locked: false });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  switch (action) {
    case "pin": {
      const result = await tryPin(s, String(body.pin ?? ""));
      if (result.ok) await grantUnlock(s);
      // A wrong PIN is an answer, not an error (browsers log 4xx responses as errors).
      return NextResponse.json(result);
    }
    case "options":
      return NextResponse.json(await unlockOptions(s));
    case "passkey": {
      const ok = await checkPasskey(s, body as unknown as Assertion);
      if (ok) await grantUnlock(s);
      return NextResponse.json(ok ? { ok } : { ok, error: "That didn't work. Use your PIN." });
    }
    case "touch": {
      const unlocked = await isUnlocked(s);
      if (unlocked) await grantUnlock(s);
      return NextResponse.json({ locked: !unlocked });
    }
    case "lock":
      await revokeUnlock(s);
      return NextResponse.json({ locked: true });
    default:
      return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
