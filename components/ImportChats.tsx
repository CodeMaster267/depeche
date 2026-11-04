"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Button, Notice } from "@/components/ui";
import type { ImportResponse } from "@/app/api/import/route";
import { IMPORT_TEXT_LIMIT, SOURCE_NAMES, batches, type ImportSource, type ImportedChat } from "@/lib/import/types";

type Found = { source: ImportSource; chats: ImportedChat[] };
type Result = { ok?: string; warn?: string; error?: string };

const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const mb = (chars: number) => (chars < 1_000_000 ? "under 1 MB" : `${Math.round(chars / 1_000_000)} MB`);

/**
 * "Bring in old chats": the browser reads an export from ChatGPT, Claude or Gemini (only the chats
 * file inside the zip, so even a huge zip is fine on a phone) and sends the chats to the server in
 * small batches. They become the person's own private chats, searchable like any other.
 */
export function ImportChats() {
  const input = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<string | null>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setResult(null);
    setFound(null);
    setStep("Reading the export");
    try {
      const { readExport } = await import("@/lib/import/read");
      const got = await readExport(file);
      if (!got.ok) setResult({ error: got.error });
      else if (!got.chats.length) setResult({ error: `That ${SOURCE_NAMES[got.source]} export has no chats in it.` });
      else setFound({ source: got.source, chats: got.chats });
    } catch {
      setResult({ error: "Couldn't read that file. It may be too big for this device; try on a computer." });
    } finally {
      setStep(null);
      if (input.current) input.current.value = "";
    }
  }

  async function run() {
    if (!found) return;
    const name = SOURCE_NAMES[found.source];
    const groups = batches(found.chats);
    let imported = 0;
    let skipped = 0;
    let sent = 0;
    let last: ImportResponse | null = null;
    setResult(null);
    try {
      for (const group of groups) {
        setStep(`Importing ${Math.min(sent + group.length, found.chats.length).toLocaleString()} of ${found.chats.length.toLocaleString()}`);
        let res: Response | null = null;
        for (let attempt = 0; attempt < 3 && !(res?.ok); attempt++) {
          if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
          res = await fetch("/api/import", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chats: group }),
          }).catch(() => null);
          if (res && res.status >= 400 && res.status < 500) break; // retrying won't help
        }
        if (!res?.ok) {
          const msg = res ? ((await res.json().catch(() => null)) as { error?: string } | null)?.error : null;
          throw new Error(msg ?? "Couldn't reach Depeche. Check your connection and try again.");
        }
        last = (await res.json()) as ImportResponse;
        imported += last.imported;
        skipped += last.skipped;
        sent += group.length;
        if (last.full) break;
      }
      const parts = [`Brought in ${plural(imported, "chat")} from ${name}.`];
      if (skipped) parts.push(`${skipped.toLocaleString()} ${skipped === 1 ? "was" : "were"} already here.`);
      const left = found.chats.length - imported - skipped;
      setResult({
        ok: parts.join(" "),
        warn: last?.full
          ? last.database_full
            ? `Depeche's free storage is nearly full, so ${plural(left, "older chat")} weren't brought in. Tell Hasan.`
            : `That fills your import space (${mb(last.limit)} of text), so ${plural(left, "older chat")} weren't brought in. Deleting imported chats frees space.`
          : undefined,
      });
      setFound(null);
    } catch (e) {
      setResult({
        error: `${e instanceof Error ? e.message : "Something went wrong."} ${imported ? `${plural(imported, "chat")} were brought in; importing again skips them.` : ""}`.trim(),
      });
    } finally {
      setStep(null);
    }
  }

  const chars = found ? found.chats.reduce((n, c) => n + c.messages.reduce((m, x) => m + x.text.length, 0), 0) : 0;

  return (
    <div className="flex flex-col gap-3" data-testid="import-chats">
      <p className="text-[15px] text-mute">
        Bring your old chats from ChatGPT, Claude or Gemini into Depeche. They stay private to you, keep their dates,
        and show up in search. Only the text comes across, not pictures or files. Imported chats aren&apos;t deleted
        after a month; each person can bring in up to {mb(IMPORT_TEXT_LIMIT)} of text.
      </p>
      <details className="text-[15px]">
        <summary className="press cursor-pointer select-none underline underline-offset-4">How to get your export</summary>
        <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-mute">
          <li>ChatGPT: Settings, Data controls, Export data. Open the email and download the zip.</li>
          <li>Claude: Settings, Privacy, Export data. Open the email and download the zip.</li>
          <li>
            Gemini: at takeout.google.com choose only My Activity, keep just Gemini Apps, and under Multiple formats
            set My Activity to JSON.
          </li>
          <li>Pick the zip as it is; there&apos;s no need to unzip it.</li>
        </ul>
      </details>
      {result?.error ? <Notice tone="error">{result.error}</Notice> : null}
      {result?.ok ? (
        <Notice>
          <span data-testid="import-result">{result.ok}</span>{" "}
          <Link href="/" className="underline underline-offset-4">
            Open chats
          </Link>
        </Notice>
      ) : null}
      {result?.warn ? <Notice tone="error">{result.warn}</Notice> : null}
      {found && !step ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-line p-4" data-testid="import-found">
          <p className="text-[15px]">
            Found {plural(found.chats.length, "chat")} from {SOURCE_NAMES[found.source]}, {chars < 1_000_000 ? "" : "about "}
            {mb(chars)} of text.
          </p>
          <div className="flex gap-3">
            <Button type="button" onClick={run} data-testid="import-start">
              Import
            </Button>
            <Button type="button" variant="secondary" onClick={() => setFound(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="secondary"
          onClick={() => input.current?.click()}
          disabled={!!step}
          aria-busy={!!step}
          data-testid="import-pick"
        >
          {step ? `${step}…` : "Choose export file"}
        </Button>
      )}
      <input
        ref={input}
        type="file"
        accept=".zip,.json,application/zip,application/json"
        className="hidden"
        data-testid="import-file"
        onChange={(e) => pick(e.target.files?.[0])}
      />
    </div>
  );
}
