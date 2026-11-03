// Copies Supabase Storage files into a backup folder, or back into a project after a restore.
//
//   node storage.mjs download DIR   reads DIR/storage-objects.json, saves each file to DIR/files/<bucket>/<name>
//   node storage.mjs upload DIR     uploads DIR/files/ to the project in SUPABASE_URL (overwrites)
//
// Needs SUPABASE_SERVICE_ROLE_KEY. SUPABASE_URL is worked out from DB_URL when it is not set.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [mode, dir] = process.argv.slice(2);
if (!dir || !["download", "upload"].includes(mode)) {
  console.error("usage: storage.mjs download|upload DIR");
  process.exit(2);
}

/** https://<ref>.supabase.co from a Supabase database address (direct or pooler). */
function projectUrl(dbUrl) {
  if (!dbUrl) return undefined;
  const u = new URL(dbUrl);
  const ref = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(u.hostname)?.[1] ?? /^postgres\.([a-z0-9]+)$/.exec(decodeURIComponent(u.username))?.[1];
  return ref ? `https://${ref}.supabase.co` : undefined;
}

const base = (process.env.SUPABASE_URL || projectUrl(process.env.DB_URL))?.replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
if (!base || !key) {
  console.error(
    "There are Storage files to copy, but SUPABASE_SERVICE_ROLE_KEY is not set (and SUPABASE_URL could not be worked out).\n" +
      "Add the Supabase secret key as the GitHub secret SUPABASE_SERVICE_ROLE_KEY so backups include files.",
  );
  process.exit(1);
}

const headers = { apikey: key, authorization: `Bearer ${key}` };
const objectUrl = (bucket, name) =>
  `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${name.split("/").map(encodeURIComponent).join("/")}`;

const objects = JSON.parse(readFileSync(join(dir, "storage-objects.json"), "utf8"));
for (const o of objects) {
  const path = join(dir, "files", o.bucket, o.name);
  if (mode === "download") {
    const res = await fetch(objectUrl(o.bucket, o.name), { headers });
    if (!res.ok) throw new Error(`Could not download ${o.bucket}/${o.name}: HTTP ${res.status}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  } else {
    const res = await fetch(objectUrl(o.bucket, o.name), {
      method: "POST",
      headers: { ...headers, "x-upsert": "true", "content-type": o.mimetype || "application/octet-stream" },
      body: readFileSync(path),
    });
    if (!res.ok) throw new Error(`Could not upload ${o.bucket}/${o.name}: HTTP ${res.status} ${await res.text()}`);
  }
}
console.log(`${mode === "download" ? "Downloaded" : "Uploaded"} ${objects.length} Storage file(s)`);
