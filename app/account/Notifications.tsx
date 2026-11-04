"use client";

import { useEffect, useState } from "react";
import { Button, Notice } from "@/components/ui";
import { pushIsOn, pushSupport, turnPushOff, turnPushOn } from "@/lib/push/client";

type State = "loading" | "install" | "unsupported" | "blocked" | "off" | "on";

/**
 * "Tell me when an answer is ready": a notification when a long answer finishes after you've left
 * the app. Turned on per device. On iPhone and iPad this only works from the home-screen app, so
 * Safari shows the two steps to add it instead.
 */
export function NotificationsToggle({ publicKey }: { publicKey: string | null }) {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  useEffect(() => {
    const support = pushSupport();
    if (support !== "ok" || !publicKey) {
      setState(support === "install" ? "install" : "unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("blocked");
      return;
    }
    pushIsOn(publicKey)
      .then((on) => setState(on ? "on" : "off"))
      .catch(() => setState("off"));
  }, [publicKey]);

  const toggle = async () => {
    if (!publicKey || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      if (state === "on") {
        await turnPushOff();
        setState("off");
      } else {
        const error = await turnPushOn(publicKey);
        if (error === "blocked") setState(Notification.permission === "denied" ? "blocked" : "off");
        else if (error) setMessage({ tone: "error", text: error });
        else setState("on");
      }
    } catch {
      setMessage({ tone: "error", text: "Couldn't change notifications on this device. Try again." });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/push/test", { method: "POST" }).catch(() => null);
    const body = (await res?.json().catch(() => ({}))) as { sent?: number; error?: string } | undefined;
    setBusy(false);
    if (!res?.ok) setMessage({ tone: "error", text: body?.error ?? "Couldn't send a test. Try again." });
    else if (!body?.sent) setMessage({ tone: "error", text: "No device got it. Turn notifications off and on again." });
    else setMessage({ tone: "info", text: "Sent. It should appear in a few seconds." });
  };

  if (state === "loading") return <p className="text-[15px] text-mute">Checking this device…</p>;

  if (state === "install") {
    return (
      <div className="flex flex-col gap-3" data-testid="push-install">
        <p className="text-[15px] text-mute">
          On iPhone and iPad, notifications only work in the Depeche app on your home screen. It takes a moment:
        </p>
        <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[15px]">
          <li>
            Tap <strong>Share</strong> (the square with an arrow) at the bottom or top of Safari.
          </li>
          <li>
            Tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
          </li>
          <li>Open Depeche from your home screen, come back here, and turn this on.</li>
        </ol>
      </div>
    );
  }

  if (state === "unsupported") {
    return <p className="text-[15px] text-mute">This browser can&apos;t show notifications. Chrome, Safari, Edge and Firefox can.</p>;
  }

  if (state === "blocked") {
    return (
      <p className="text-[15px] text-mute" data-testid="push-blocked">
        Notifications are blocked for Depeche on this device. On iPhone or iPad, open <strong>Settings</strong>, then{" "}
        <strong>Notifications</strong>, then <strong>Depeche</strong>, and turn on Allow Notifications. On a computer,
        click the icon left of the address bar and allow notifications. Then come back here.
      </p>
    );
  }

  const on = state === "on";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <p className="text-[15px] text-mute" id="push-help">
          {on
            ? "This device gets a notification when an answer finishes after you've left the app. Tap it to open the chat."
            : "Get a notification on this device when an answer finishes after you've left the app. It names the chat, never what's in it."}
        </p>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Tell me when an answer is ready"
          aria-describedby="push-help"
          disabled={busy}
          onClick={toggle}
          className={`relative h-8 w-[52px] shrink-0 rounded-full border transition-colors disabled:opacity-60 ${on ? "border-fg bg-fg" : "border-line bg-soft"}`}
        >
          <span className={`absolute top-[3px] h-6 w-6 rounded-full shadow transition-[left] ${on ? "left-[24px] bg-bg" : "left-[3px] bg-fg"}`} />
        </button>
      </div>
      {on ? (
        <Button type="button" variant="secondary" disabled={busy} onClick={test}>
          Send a test notification
        </Button>
      ) : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
    </div>
  );
}
