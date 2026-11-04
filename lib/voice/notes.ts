/**
 * Voice notes and other recordings people attach to a message. Shared by the browser and the
 * server.
 *
 * Models here don't take audio, so a recording is written out instead: the browser puts it in the
 * private "voice-notes" bucket (Vercel can't take bodies over 4.5 MB), the server hands it to the
 * family's speech provider, deletes it, and the transcript is attached as a text file.
 */
export const VOICE_NOTE_BUCKET = "voice-notes";
/** OpenAI's limit for one recording is 25 MB. */
export const MAX_VOICE_NOTE_BYTES = 25 * 1024 * 1024;
/** Half an hour: long enough for a lecture or a meeting, short enough to write out in one go. */
export const MAX_VOICE_NOTE_SECONDS = 30 * 60;

/** The types a recording is stored as, with the file ending speech providers expect for each. */
export const AUDIO_TYPES: Record<string, string> = {
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/aac": "aac",
  "audio/flac": "flac",
};

const BY_ENDING: Record<string, string> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  mp3: "audio/mpeg",
  mpga: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  webm: "audio/webm",
  weba: "audio/webm",
  flac: "audio/flac",
  caf: "", // iPhone's own format: no speech provider takes it
};

const BY_TYPE: Record<string, string> = {
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/mp4": "audio/mp4",
  "audio/aac": "audio/aac",
  "audio/x-aac": "audio/aac",
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mpeg",
  "audio/wav": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/ogg": "audio/ogg",
  "audio/opus": "audio/ogg",
  "audio/webm": "audio/webm",
  "audio/flac": "audio/flac",
  "audio/x-flac": "audio/flac",
};

/**
 * What a picked file is stored as if it is a recording, or null if it isn't one. The file's ending
 * wins over the browser's guess, since phones label voice notes in many ways (WhatsApp's .opus
 * often comes with no type at all).
 */
export function audioType(file: { name: string; type: string }): string | null {
  const ending = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  if (ending && ending in BY_ENDING) return BY_ENDING[ending] || null;
  const type = file.type.split(";")[0].trim().toLowerCase();
  if (type in BY_TYPE) return BY_TYPE[type];
  return null;
}

/** Looks like a recording, even one Depeche can't write out (so it can say why). */
export const looksLikeAudio = (file: { name: string; type: string }) =>
  file.type.startsWith("audio/") || /\.(m4a|aac|mp3|mpga|wav|ogg|oga|opus|webm|weba|flac|caf|amr|aiff?|wma)$/i.test(file.name);

/** The transcript's file name: "Lecture.m4a" becomes "Lecture transcript.txt". */
export function transcriptName(name: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, "").trim() || "Voice note";
  return `${base.slice(0, 150)} transcript.txt`;
}

/** The file a provider is sent: a plain name with the ending it recognises. */
export const providerFileName = (mime: string) => `recording.${AUDIO_TYPES[mime] ?? "m4a"}`;

/** "1:05" or "1:02:05". */
export function durationLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A path in someone's own voice-notes folder, as the server accepts it. */
export function isVoiceNotePath(path: unknown, ownerId: string): path is string {
  return (
    typeof path === "string" &&
    path.startsWith(`${ownerId}/`) &&
    path.length < 300 &&
    !path.includes("..") &&
    /^[\w./-]+$/.test(path)
  );
}

/**
 * Seconds to charge for and to hold money for. The browser reports the length it read from the
 * file; if it couldn't, the length is worked out from the size at a low bit rate (16 kbit/s), which
 * errs long. Either way it is kept within half an hour.
 */
export function chargeableSeconds(reported: unknown, bytes: number): number {
  const fromSize = bytes / 2_000;
  const n = typeof reported === "number" && Number.isFinite(reported) && reported > 0 ? reported : fromSize;
  return Math.min(MAX_VOICE_NOTE_SECONDS, Math.max(1, Math.ceil(n)));
}
