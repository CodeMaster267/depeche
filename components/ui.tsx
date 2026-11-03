"use client";

import { useFormStatus } from "react-dom";
import { createContext, useContext, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";

/** Small building blocks for Depeche's forms: black and white, large touch targets. */

/**
 * React clears a form after its action runs. When the action failed, `keepOnError` hands back what
 * the person typed (never passwords), and every Field inside `<Kept values={…}>` shows it again.
 */
type Values = Record<string, string>;
const KeptValues = createContext<Values>({});

export function Kept({ values, children }: { values?: Values; children: ReactNode }) {
  return <KeptValues.Provider value={values ?? {}}>{children}</KeptValues.Provider>;
}

export function keepOnError<S extends { error?: string }>(
  action: (prev: S | undefined, form: FormData) => Promise<S | undefined>,
) {
  return async (prev: (S & { values?: Values }) | undefined, form: FormData): Promise<(S & { values?: Values }) | undefined> => {
    const result = await action(prev, form);
    if (!result?.error) return result;
    const values: Values = {};
    for (const [k, v] of form.entries()) if (typeof v === "string" && !/password/i.test(k) && !k.startsWith("$")) values[k] = v;
    return { ...result, values };
  };
}

export function Field({ label, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const kept = useContext(KeptValues);
  if (props.name && props.type !== "password" && kept[props.name] !== undefined) props = { ...props, defaultValue: kept[props.name] };
  return (
    <label className="flex flex-col gap-1.5">
      <span className="sr-only">{label}</span>
      <input
        aria-label={label}
        placeholder={label}
        {...props}
        className="h-14 w-full rounded-2xl border border-line bg-bg px-4 text-[17px] text-fg outline-none placeholder:text-faint focus:border-fg"
      />
      {hint ? <span className="px-1 text-[13px] text-mute">{hint}</span> : null}
    </label>
  );
}

export function Button({
  variant = "primary",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "quiet" }) {
  const look = {
    primary: "bg-inv text-on-inv",
    secondary: "border border-line bg-bg text-fg",
    quiet: "text-mute underline underline-offset-4 h-auto",
  }[variant];
  // Inside a form, show that the server is working until it answers.
  const { pending } = useFormStatus();
  const busy = pending && props.type !== "button";
  return (
    <button
      aria-busy={busy || undefined}
      data-busy={busy ? "" : undefined}
      {...props}
      className={`press inline-flex h-14 w-full items-center justify-center gap-3 rounded-2xl px-5 text-[17px] font-semibold transition-opacity disabled:opacity-50 ${look} ${className}`}
    >
      {children}
    </button>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error"; children: ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-2xl px-4 py-3 text-[15px] ${tone === "error" ? "border border-fg text-fg" : "bg-soft text-fg"}`}
    >
      {children}
    </p>
  );
}

export function GoogleMark() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 10.2v3.9h5.5c-.24 1.4-1.7 4.1-5.5 4.1-3.3 0-6-2.7-6-6.2s2.7-6.2 6-6.2c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.3 14.6 2.3 12 2.3 6.6 2.3 2.3 6.6 2.3 12s4.3 9.7 9.7 9.7c5.6 0 9.3-3.9 9.3-9.5 0-.6-.1-1.1-.2-1.6H12z" />
    </svg>
  );
}

/** The full-height column used by the sign-in, setup and invite pages. */
export function TitleCardPage({ children }: { children: ReactNode }) {
  return (
    <main
      className="mx-auto flex min-h-full w-full max-w-[440px] flex-col justify-center gap-4 px-7 py-10"
      style={{ paddingTop: "max(2.5rem, env(safe-area-inset-top))", paddingBottom: "max(2.5rem, env(safe-area-inset-bottom))" }}
    >
      {children}
    </main>
  );
}
