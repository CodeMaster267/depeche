"use client";

import { useEffect, useState } from "react";
import { saveVoiceLanguages, voiceLanguages } from "@/lib/voice/client";

/** Common languages in the families using Depeche, plus whatever the device says it speaks. */
const COMMON = ["en", "ur", "hi", "pa", "ar", "bn", "fa", "tr", "es", "fr", "de", "it", "pt", "ru", "zh", "ja", "ko", "id", "ms", "ta"];

function name(code: string) {
  try {
    return new Intl.DisplayNames([navigator.language || "en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Which languages voice chat should expect, main one first. Picking two lets it write out speech
 * that mixes them, each part in its own language, instead of guessing one and translating.
 */
export function LanguagePicker() {
  const [open, setOpen] = useState(false);
  const [langs, setLangs] = useState<string[]>([]);
  useEffect(() => setLangs(voiceLanguages()), []);
  if (!langs.length) return null;

  const toggle = (code: string) => {
    const next = langs.includes(code) ? langs.filter((l) => l !== code) : [...langs, code].slice(0, 4);
    if (!next.length) return;
    setLangs(next);
    saveVoiceLanguages(next);
  };
  const choices = [...new Set([...langs, ...COMMON])];

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="press rounded-full border border-line px-3.5 py-1.5 text-[14px] text-mute"
      >
        Languages: {langs.map(name).join(" + ")}
      </button>
      {open ? (
        <div role="group" aria-label="Languages you speak" className="flex max-w-[34rem] flex-wrap justify-center gap-2">
          {choices.map((code) => {
            const on = langs.includes(code);
            return (
              <button
                key={code}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(code)}
                className={`press rounded-full border px-3 py-1 text-[14px] ${on ? "border-fg bg-fg text-bg" : "border-line"}`}
              >
                {name(code)}
              </button>
            );
          })}
          <p className="w-full text-center text-[13px] text-mute">Pick every language you mix. The first one is your main language.</p>
        </div>
      ) : null}
    </div>
  );
}
