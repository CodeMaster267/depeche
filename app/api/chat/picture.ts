import "server-only";
import { after } from "next/server";
import type { Me } from "@/lib/auth/session";
import type { supabaseServer } from "@/lib/supabase/server";
import type { supabaseAdmin } from "@/lib/supabase/admin";
import type { Model } from "@/lib/ai/models";
import { ProviderError } from "@/lib/ai/providers";
import { makePicture, type Picture } from "@/lib/ai/images";
import { MAX_IMAGES_IN, imageCost, imageHold, pictureName } from "@/lib/ai/image-cost";
import { UPLOAD_BUCKET, type FileRef } from "@/lib/chat/files";
import { activePath, titleFrom, type MessageRow } from "@/lib/chat/thread";
import { allow } from "@/lib/rate-limit";

type Args = {
  me: Me;
  db: Awaited<ReturnType<typeof supabaseServer>>;
  admin: ReturnType<typeof supabaseAdmin>;
  model: Model;
  apiKey: string;
  chatId: string | null;
  all: MessageRow[];
  text: string;
  files: FileRef[];
  clientRequestId?: string;
  regenerate?: string;
};

const fail = (status: number, error: string) => Response.json({ error }, { status });

/**
 * A message to a picture model: the text describes the picture, and pictures attached to it are
 * edited. Streams the same events as a reply ({type:"start"}, {type:"making"} every few seconds
 * while the picture is drawn, then {type:"done"} or {type:"error"}). The pictures are stored in
 * the person's own folder, like uploads, and deleted the same way after 3 days without use.
 */
export async function pictureReply(a: Args): Promise<Response> {
  const { me, db, admin, model } = a;
  if (!(await allow(["picturesPerDay", me.userId]))) {
    return fail(429, "You've made a lot of pictures today. Try again tomorrow.");
  }

  // What's being answered: a new message, or an earlier one made again.
  let question: MessageRow | undefined;
  if (a.regenerate) {
    question = a.all.find((m) => m.id === a.regenerate && m.role === "user");
    if (!question) return fail(404, "That message doesn't exist.");
  }
  const prompt = (question ? (question.content.text ?? "") : a.text).trim();
  if (!prompt) return fail(400, "Describe the picture you'd like, or what to change.");
  const toEdit = (question ? (question.content.files ?? []) : a.files).filter((f) => f.mime.startsWith("image/")).slice(0, MAX_IMAGES_IN);
  const picturesIn = model.provider === "xai" ? Math.min(1, toEdit.length) : toEdit.length;

  // The most this could cost is held against the monthly limit before anything is spent.
  const want = Number(imageHold(model, prompt, picturesIn).toFixed(6));
  const { data: holds, error: holdError } = await admin.rpc("reserve_spend", { p_person: me.userId, p_want: want, p_need: want });
  const hold = (holds as { hold_id: string }[] | null)?.[0];
  if (!hold) return fail(402, holdError?.code === "P0001" ? `${holdError.message}.` : "Couldn't check your spending limit. Try again.");
  const settle = (message: string | null, cost: number, input = 0, output = 0) =>
    admin.rpc("settle_spend", {
      p_hold: hold.hold_id, p_message: message, p_provider: model.provider, p_model: model.id,
      p_input: input, p_output: output, p_cost: Number(cost.toFixed(6)),
    });

  let chatId = a.chatId;
  if (!chatId) {
    const { data: chat, error } = await db
      .from("chats")
      .insert({ owner_id: me.userId, title: titleFrom(prompt), model: model.id })
      .select("id")
      .single<{ id: string }>();
    if (error || !chat) {
      await settle(null, 0);
      return fail(500, "Couldn't start a chat. Try again.");
    }
    chatId = chat.id;
  }
  if (!question) {
    const parent = activePath(a.all).at(-1);
    const { data: inserted, error } = await db
      .from("messages")
      .insert({
        chat_id: chatId,
        owner_id: me.userId,
        parent_id: parent?.id ?? null,
        role: "user",
        content: a.files.length ? { text: a.text, files: a.files.map(({ path, name, mime, size }) => ({ path, name, mime, size })) } : { text: a.text },
        client_request_id: a.clientRequestId,
      })
      .select("id, chat_id, parent_id, role, content, status, model, created_at")
      .single<MessageRow>();
    if (error || !inserted) {
      await settle(null, 0);
      return fail(error?.code === "23505" ? 409 : 500, error?.code === "23505" ? "Already sent." : "Couldn't send that. Try again.");
    }
    question = inserted;
  }

  // The pictures to edit, read from the sender's own folder only.
  const storage = admin.storage.from(UPLOAD_BUCKET);
  const images: Picture[] = [];
  let missing = 0;
  for (const f of toEdit) {
    if (!f.path.startsWith(`${me.userId}/`)) continue;
    const { data: blob } = await storage.download(f.path);
    if (blob) images.push({ mime: f.mime, data: Buffer.from(await blob.arrayBuffer()) });
    else missing++;
  }

  // A picture is billed once asked for, so it is always finished and saved, even if the person
  // taps Stop or closes the app; it shows up when they come back.
  const abort = new AbortController();
  const encoder = new TextEncoder();
  const asked = question;
  const finalChatId = chatId;
  // Keep going if the app is closed, so the picture is still saved and paid for only once.
  let finished!: () => void;
  after(new Promise<void>((resolve) => (finished = resolve)));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (event: object) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          open = false;
        }
      };
      send({ type: "start", chatId: finalChatId, userMessageId: asked.id, userMessage: asked });
      send({ type: "making", editing: images.length > 0 });
      // Some phones drop a connection that is quiet for long, and pictures can take a minute.
      const beat = setInterval(() => send({ type: "making", editing: images.length > 0 }), 8000);

      let status: MessageRow["status"] = "completed";
      let error: string | undefined;
      let notice: string | undefined = missing
        ? "A picture to edit was no longer available (pictures are removed after 3 days without use), so it was left out."
        : undefined;
      let text = "";
      const saved: FileRef[] = [];
      let cost = 0;
      let tokens = { input: 0, output: 0 };
      try {
        if (toEdit.length && !images.length) throw new ProviderError("The picture to edit is no longer available: pictures are removed after 3 days without use. Attach it again.");
        const made = await makePicture({ model, apiKey: a.apiKey, prompt, images, signal: abort.signal });
        text = made.text;
        cost = imageCost(model, made.usage, images.length, made.images.length);
        if (made.usage) tokens = { input: made.usage.textIn + made.usage.imagesIn, output: made.usage.imageOut + made.usage.textOut };
        for (const [i, pic] of made.images.entries()) {
          const name = pictureName(prompt, pic.mime, i);
          const path = `${me.userId}/${crypto.randomUUID()}/${name}`;
          const { error: upError } = await storage.upload(path, pic.data, { contentType: pic.mime, upsert: false });
          if (!upError) saved.push({ path, name, mime: pic.mime, size: pic.data.length });
        }
        if (made.images.length && !saved.length) throw new ProviderError("The picture was made but couldn't be saved. Try again.");
        if (model.provider === "xai" && toEdit.length > 1) {
          notice = [notice, `${model.name} edits one picture at a time, so only the first was used.`].filter(Boolean).join(" ");
        }
      } catch (e) {
        if (abort.signal.aborted) {
          status = "stopped";
          // A stopped request may still be billed, so count what one picture costs (erring high).
          cost = imageCost(model, undefined, images.length, 1);
        } else {
          status = "failed";
          error = e instanceof ProviderError ? e.message : "Something went wrong while making the picture. Try again.";
          console.error("[picture]", model.id, e instanceof Error ? e.message : e);
        }
      } finally {
        clearInterval(beat);
      }

      const { data: reply } = await admin
        .from("messages")
        .insert({
          chat_id: finalChatId,
          owner_id: me.userId,
          parent_id: asked.id,
          role: "assistant",
          content: {
            text,
            ...(saved.length ? { files: saved } : {}),
            ...(notice ? { notice } : {}),
            ...(error ? { error } : {}),
            cost,
          },
          status,
          provider: model.provider,
          model: model.id,
        })
        .select("id, chat_id, parent_id, role, content, status, model, created_at")
        .single<MessageRow>();
      await Promise.all([
        settle(reply?.id ?? null, cost, tokens.input, tokens.output),
        admin.from("chats").update({ updated_at: new Date().toISOString(), model: model.id }).eq("id", finalChatId),
      ]);
      if (error) send({ type: "error", error, message: reply });
      else send({ type: "done", message: reply });
      try {
        if (open) controller.close();
      } catch {
        // The browser already went away.
      }
      finished();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
