import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Wordmark } from "@/components/Wordmark";
import { Markdown } from "@/components/markdown/Markdown";
import { Sources } from "@/components/chat/Sources";
import { FileIcon } from "@/components/chat/icons";
import { findModel } from "@/lib/ai/models";
import { isShareToken, type SharedMessage } from "@/lib/chat/share";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Never indexed, and the link (its token) is never sent on to sites a reader clicks through to.
export const metadata: Metadata = {
  title: "Shared chat · Depeche",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * A shared chat: a read-only copy of one person's chat, frozen when they shared it. Anyone with the
 * link can open it; the owner can stop sharing at any time and the link then shows "not found".
 */
export default async function SharedChat({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isShareToken(token)) notFound();
  const { data } = await (await supabaseServer())
    .rpc("shared_chat", { p_token: token })
    .maybeSingle<{ title: string; messages: SharedMessage[]; updated_at: string }>();
  if (!data) notFound();
  const when = new Date(data.updated_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <div className="min-h-dvh" style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
      <header className="border-b border-line">
        <div className="mx-auto flex w-full max-w-[760px] items-center justify-between px-5 py-3 md:px-8">
          <Link href="/" className="text-[20px]" aria-label="Depeche">
            <Wordmark />
          </Link>
          <span className="text-[13px] text-mute">Read only</span>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-[760px] flex-col gap-7 px-5 py-8 md:px-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight">{data.title}</h1>
          <p className="text-[14px] text-mute">Shared chat · {when}</p>
        </div>
        {data.messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex flex-col items-end gap-2">
              {m.files?.length ? (
                <div className="flex flex-wrap justify-end gap-2">
                  {m.files.map((f, j) => (
                    <span key={j} className="flex max-w-[260px] items-center gap-2 rounded-2xl border border-line px-3 py-2.5 text-mute">
                      <FileIcon className="shrink-0" />
                      <span className="truncate text-[14px]">{f.name}</span>
                    </span>
                  ))}
                </div>
              ) : null}
              {m.text ? (
                <div
                  data-testid="user-message"
                  className="max-w-[85%] whitespace-pre-wrap break-words rounded-[22px] bg-inv px-5 py-3 text-[17px] leading-relaxed text-on-inv"
                >
                  {m.text}
                </div>
              ) : null}
            </div>
          ) : (
            <article key={i} data-testid="reply" className="flex flex-col gap-3">
              <Markdown text={m.text} />
              {m.sources?.length ? <Sources sources={m.sources} /> : null}
              {m.model ? <span className="self-end font-mono text-[12px] text-mute">{findModel(m.model)?.short ?? m.model}</span> : null}
            </article>
          ),
        )}
        <p className="border-t border-line pt-6 text-center text-[13px] text-mute">
          Shared from depeche. Files attached to this chat aren&apos;t included, only their names.
        </p>
      </main>
    </div>
  );
}
