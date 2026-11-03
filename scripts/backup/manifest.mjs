// The backup's table of contents, and the check that a restore matches it.
//
//   node manifest.mjs write DIR            counts the rows in DIR/data.sql and checksums DIR/files/
//   node manifest.mjs check DIR DB_URL     checks a restored database (and the files) against it
//   node manifest.mjs prune DIR            writes DIR/data-restore.sql: data.sql without empty tables
//
// The counts come from the dump itself, so they are exact even if people kept chatting while the
// backup ran. `check` prints a one-line JSON report and exits non-zero on any difference.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countCopyRows, withoutEmptyCopies } from "./copy-rows.mjs";

const [mode, dir, dbUrl] = process.argv.slice(2);
if (!dir || !["write", "check", "prune"].includes(mode) || (mode === "check" && !dbUrl)) {
  console.error("usage: manifest.mjs write DIR | check DIR DB_URL | prune DIR");
  process.exit(2);
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const readJson = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const quoteIdent = (s) => `"${s.replaceAll('"', '""')}"`;
const quoteLiteral = (s) => `'${s.replaceAll("'", "''")}'`;

/** Checks every Storage file listed in the backup is there, the right size, and (if known) unchanged. */
function checkFiles(objects, expected) {
  const problems = [];
  for (const o of objects) {
    const path = join(dir, "files", o.bucket, o.name);
    if (!existsSync(path)) {
      problems.push(`missing file ${o.bucket}/${o.name}`);
      continue;
    }
    const bytes = readFileSync(path).length;
    if (o.size != null && bytes !== Number(o.size)) problems.push(`${o.bucket}/${o.name} is ${bytes} bytes, expected ${o.size}`);
    const want = expected?.[`${o.bucket}/${o.name}`];
    if (want && want !== sha256(path)) problems.push(`${o.bucket}/${o.name} checksum changed`);
  }
  return problems;
}

if (mode === "prune") {
  writeFileSync(join(dir, "data-restore.sql"), withoutEmptyCopies(readFileSync(join(dir, "data.sql"), "utf8")));
} else if (mode === "write") {
  const tables = countCopyRows(readFileSync(join(dir, "data.sql"), "utf8"));
  const objects = readJson("storage-objects.json");
  const problems = checkFiles(objects);
  if (problems.length) {
    console.error(`Storage files do not match their metadata:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  const files = Object.fromEntries(objects.map((o) => [`${o.bucket}/${o.name}`, sha256(join(dir, "files", o.bucket, o.name))]));
  const manifest = {
    format: 1,
    created_at: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    tables,
    rows: Object.values(tables).reduce((a, b) => a + b, 0),
    migrations: readJson("migrations.json").length,
    files,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Manifest: ${manifest.rows} rows in ${Object.keys(tables).length} tables, ${objects.length} file(s), ${manifest.migrations} migration(s)`);
} else {
  const manifest = readJson("manifest.json");
  const names = Object.keys(manifest.tables);
  const sql = names.length
    ? `select json_object_agg(k, n) from (values ${names
        .map((t) => {
          const [schema, ...rest] = t.split(".");
          return `(${quoteLiteral(t)}, (select count(*) from ${quoteIdent(schema)}.${quoteIdent(rest.join("."))}))`;
        })
        .join(", ")}) as c(k, n)`
    : "select '{}'::json";
  const restored = JSON.parse(execFileSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-Atc", sql], { encoding: "utf8" }));
  const problems = names
    .filter((t) => Number(restored[t]) !== manifest.tables[t])
    .map((t) => `${t}: restored ${restored[t]} rows, backup has ${manifest.tables[t]}`);
  problems.push(...checkFiles(readJson("storage-objects.json"), manifest.files));
  const report = {
    ok: problems.length === 0,
    backup_created_at: manifest.created_at,
    tables: names.length,
    rows: manifest.rows,
    files: Object.keys(manifest.files).length,
    problems,
  };
  console.log(JSON.stringify(report));
  if (!report.ok) process.exit(1);
}
