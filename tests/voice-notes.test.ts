import { describe, expect, it } from "vitest";
import { audioType, chargeableSeconds, durationLabel, isVoiceNotePath, looksLikeAudio, transcriptName } from "@/lib/voice/notes";

const U = "00000000-0000-4000-8000-000000000001";

describe("voice notes", () => {
  it("reads iPhone, WhatsApp and other recordings by their ending, whatever the browser says", () => {
    expect(audioType({ name: "New Recording.m4a", type: "audio/x-m4a" })).toBe("audio/mp4");
    expect(audioType({ name: "PTT-2026.opus", type: "" })).toBe("audio/ogg");
    expect(audioType({ name: "song.mp3", type: "audio/mpeg" })).toBe("audio/mpeg");
    expect(audioType({ name: "memo", type: "audio/wav" })).toBe("audio/wav");
    expect(audioType({ name: "photo.jpg", type: "image/jpeg" })).toBeNull();
  });

  it("knows a recording it can't write out, so it can say so", () => {
    expect(audioType({ name: "call.caf", type: "audio/x-caf" })).toBeNull();
    expect(looksLikeAudio({ name: "call.caf", type: "audio/x-caf" })).toBe(true);
    expect(looksLikeAudio({ name: "notes.txt", type: "text/plain" })).toBe(false);
  });

  it("names the transcript after the recording", () => {
    expect(transcriptName("Lecture 3.m4a")).toBe("Lecture 3 transcript.txt");
    expect(transcriptName(".m4a")).toBe("Voice note transcript.txt");
  });

  it("shows lengths like a player does", () => {
    expect(durationLabel(65)).toBe("1:05");
    expect(durationLabel(3725)).toBe("1:02:05");
  });

  it("accepts only paths in the person's own folder", () => {
    expect(isVoiceNotePath(`${U}/abc/note.m4a`, U)).toBe(true);
    expect(isVoiceNotePath(`${U}/../other/note.m4a`, U)).toBe(false);
    expect(isVoiceNotePath(`00000000-0000-4000-8000-000000000002/a/note.m4a`, U)).toBe(false);
    expect(isVoiceNotePath(42, U)).toBe(false);
  });

  it("charges the length the browser read, or errs long from the size, never past half an hour", () => {
    expect(chargeableSeconds(61.2, 1_000_000)).toBe(62);
    expect(chargeableSeconds(null, 1_000_000)).toBe(500);
    expect(chargeableSeconds(99_999, 1_000)).toBe(1800);
    expect(chargeableSeconds(-5, 10)).toBe(1);
  });
});
