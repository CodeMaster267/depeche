"use client";

import { useState } from "react";
import { Button, Notice } from "@/components/ui";

/**
 * "Download everything": the browser gathers the person's own data (row-level security decides
 * what it can read), zips it and saves it. Nothing big passes through Vercel, so there is no size
 * limit beyond the phone's memory, and it costs nothing.
 */
export function ExportButton({ userId, email }: { userId: string; email: string }) {
  const [step, setStep] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok?: string; error?: string } | null>(null);

  async function run() {
    setResult(null);
    setStep("Starting");
    try {
      const [{ supabaseBrowser }, collect, archive] = await Promise.all([
        import("@/lib/supabase/browser"),
        import("@/lib/export/collect"),
        import("@/lib/export/archive"),
      ]);
      const db = supabaseBrowser();
      const data = await collect.collectData(db, userId, { email }, setStep);
      const files = await collect.collectFiles(db, userId, data.messages, setStep);
      setStep("Making the zip");
      const name = archive.exportFileName(data.exportedAt);
      const zip = archive.zipEntries(archive.exportEntries(data, files), name);
      collect.saveBlob(new Blob([zip as BlobPart], { type: "application/zip" }), `${name}.zip`);
      const kept = files.filter((f) => f.data).length;
      setResult({
        ok: `Saved ${name}.zip: ${data.chats.length} chat${data.chats.length === 1 ? "" : "s"}, ${data.memories.length} memor${data.memories.length === 1 ? "y" : "ies"}, ${kept} file${kept === 1 ? "" : "s"}.`,
      });
    } catch {
      setResult({ error: "Couldn't make the download. Check your connection and try again." });
    } finally {
      setStep(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {result?.error ? <Notice tone="error">{result.error}</Notice> : result?.ok ? <Notice>{result.ok}</Notice> : null}
      <Button type="button" variant="secondary" onClick={run} disabled={!!step} aria-busy={!!step} data-testid="export-everything">
        {step ? `${step}…` : "Download everything"}
      </Button>
    </div>
  );
}
