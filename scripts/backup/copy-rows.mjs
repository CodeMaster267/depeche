// Shared by manifest.mjs and its test.

/** Rows per table in a `supabase db dump --data-only --use-copy` file. */
export function countCopyRows(sql) {
  const counts = {};
  let table = null;
  for (const line of sql.split("\n")) {
    if (table) {
      if (line === "\\.") table = null;
      else counts[table] += 1;
      continue;
    }
    const m = /^COPY "((?:[^"]|"")+)"\."((?:[^"]|"")+)" .* FROM stdin;$/.exec(line);
    if (m) {
      table = `${m[1]}.${m[2]}`;
      counts[table] = 0;
    }
  }
  if (table) throw new Error(`data.sql ends inside the rows of ${table}`);
  return counts;
}

/**
 * The same dump without COPY blocks that have no rows. Restoring an empty table changes nothing,
 * and leaving those out means a Supabase table the `postgres` role may not write to (newer
 * Storage features Depeche doesn't use) cannot fail an otherwise good restore.
 */
export function withoutEmptyCopies(sql) {
  const lines = sql.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^COPY .* FROM stdin;$/.test(lines[i]) && lines[i + 1] === "\\.") {
      i += 1;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}
