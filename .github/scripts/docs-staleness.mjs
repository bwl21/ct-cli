#!/usr/bin/env node
// Staleness gate for docs/handbuch/ — the pages published into the Handbuch's
// "ChurchTools-Grundlagen" section.
//
// Each page declares the code it documents in `sources:` and signs it with
// `sources_hash`. Change a declared source without re-signing the page and this
// fails, so that someone re-reads the page against the new code. Bumping
// `reviewed:` alone does NOT satisfy the gate — that is the entire point.
//
// The signature is a sha256 over each resolved file's `<repo-relative-path>\0<contents>\0`,
// files sorted by path, truncated to 16 hex chars. This is a port of
// `App\Services\Docs\SourcesHasher` from the estate-wide checker; it is inlined here
// because that implementation lives in a private repo and a public repo cannot call a
// reusable workflow out of one. Verified to reproduce the hashes the PHP signer wrote.
//
//   node .github/scripts/docs-staleness.mjs          # check (CI)
//   node .github/scripts/docs-staleness.mjs --sign   # re-sign every stale page

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const DOCS_DIR = "docs/handbuch";
const SIGN = process.argv.includes("--sign");

/** Frontmatter fields this gate reads. The subset is deliberate — no YAML dependency. */
function parseFrontmatter(text, page) {
  if (!text.startsWith("---\n")) throw new Error(`${page}: no frontmatter`);
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) throw new Error(`${page}: unterminated frontmatter`);
  const body = text.slice(4, end + 1);

  const fm = { sources: [] };
  let inSources = false;
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (inSources && item) {
      fm.sources.push(item[1].trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    inSources = false;
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim().replace(/^["']|["']$/g, "");
    if (key === "sources") {
      // Either `sources: []` inline or a block list on the following lines.
      if (value === "[]") fm.sources = [];
      else inSources = true;
      continue;
    }
    fm[key] = value;
  }
  return { fm, frontmatterEnd: end + 5 };
}

/** Walk a directory, returning repo-relative paths. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(relative(ROOT, full).split(sep).join("/"));
  }
  return out;
}

/**
 * Resolve one `sources:` entry to repo-relative file paths. Supports a literal path,
 * a `**` prefix-walk (`src/permissions/**`) and `*` within a single segment.
 */
function resolve(pattern) {
  if (!pattern.includes("*")) {
    try {
      if (statSync(join(ROOT, pattern)).isFile()) return [pattern];
      return walk(join(ROOT, pattern));
    } catch {
      throw new Error(`sources entry does not exist: ${pattern}`);
    }
  }

  const deep = pattern.indexOf("**");
  if (deep !== -1) {
    const base = pattern.slice(0, deep).replace(/\/$/, "");
    return walk(join(ROOT, base));
  }

  const rx = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$");
  const dir = pattern.slice(0, pattern.lastIndexOf("/"));
  return walk(join(ROOT, dir)).filter((f) => rx.test(f));
}

function signature(sources) {
  const files = [...new Set(sources.flatMap(resolve))].sort();
  if (!files.length) throw new Error("sources resolved to no files");
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update("\0");
    h.update(readFileSync(join(ROOT, f)));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

const pages = readdirSync(join(ROOT, DOCS_DIR))
  .filter((f) => f.endsWith(".md"))
  .map((f) => `${DOCS_DIR}/${f}`)
  .sort();

const stale = [];
const errors = [];

for (const page of pages) {
  const text = readFileSync(join(ROOT, page), "utf8");
  let parsed;
  try {
    parsed = parseFrontmatter(text, page);
  } catch (e) {
    errors.push(e.message);
    continue;
  }
  const { fm } = parsed;

  if (fm.sources_exempt_reason) {
    if (fm.sources.length) errors.push(`${page}: exempt pages must declare \`sources: []\``);
    console.log(`  exempt  ${page} — ${fm.sources_exempt_reason}`);
    continue;
  }

  if (!fm.sources.length) {
    errors.push(`${page}: no \`sources:\` and no \`sources_exempt_reason:\``);
    continue;
  }

  let actual;
  try {
    actual = signature(fm.sources);
  } catch (e) {
    errors.push(`${page}: ${e.message}`);
    continue;
  }

  if (actual === fm.sources_hash) {
    console.log(`  ok      ${page}`);
    continue;
  }

  stale.push({ page, expected: fm.sources_hash ?? "(unsigned)", actual });
  if (SIGN) {
    const signed = fm.sources_hash
      ? text.replace(`sources_hash: ${fm.sources_hash}`, `sources_hash: ${actual}`)
      : text.replace(/^---\n/, `---\nsources_hash: ${actual}\n`);
    writeFileSync(join(ROOT, page), signed);
    console.log(`  signed  ${page} → ${actual}`);
  } else {
    console.log(`  STALE   ${page} — signed ${fm.sources_hash ?? "(unsigned)"}, now ${actual}`);
  }
}

if (errors.length) {
  console.error("\nFrontmatter errors:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

if (stale.length && !SIGN) {
  console.error(
    `\n${stale.length} page(s) document code that changed since they were last read.\n` +
      `Re-read each page against its sources, then re-sign:\n\n` +
      `    node .github/scripts/docs-staleness.mjs --sign\n\n` +
      `Bumping \`reviewed:\` alone does not satisfy this gate.`,
  );
  process.exit(1);
}

console.log(SIGN ? `\n${stale.length} page(s) re-signed.` : `\nAll ${pages.length} page(s) current.`);
