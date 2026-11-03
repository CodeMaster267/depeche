import { describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript shared with the backup scripts
import { countCopyRows, withoutEmptyCopies } from "../scripts/backup/copy-rows.mjs";

const dump = [
  "SET session_replication_role = replica;",
  'COPY "auth"."users" ("id", "email") FROM stdin;',
  "1\thasan@example.com",
  "2\tamir@example.com",
  "\\.",
  'COPY "public"."memories" ("id") FROM stdin;',
  "\\.",
  'COPY "public"."chats" ("id", "title") FROM stdin;',
  "3\tLine one\\nline two",
  "\\.",
  "RESET ALL;",
].join("\n");

describe("backup dump", () => {
  it("counts rows per table, one line per row", () => {
    expect(countCopyRows(dump)).toEqual({ "auth.users": 2, "public.memories": 0, "public.chats": 1 });
  });

  it("refuses a dump that was cut off", () => {
    expect(() => countCopyRows(dump.split("\n").slice(0, 3).join("\n"))).toThrow(/ends inside/);
  });

  it("drops only the empty tables before a restore", () => {
    const pruned = withoutEmptyCopies(dump);
    expect(pruned).not.toContain("memories");
    expect(countCopyRows(pruned)).toEqual({ "auth.users": 2, "public.chats": 1 });
    expect(pruned).toContain("RESET ALL;");
  });
});
