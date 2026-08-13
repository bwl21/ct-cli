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

/**
 * Frontmatter fields this gate reads. The subset is deliberate — no YAML dependency.
 *
 * Strictness is asymmetric on purpose, because the two directions are not equally bad:
 *
 *   - Inside `sources:`, ANY line not positively understood is an error, never a skip.
 *     A dropped entry means the gate passes while the docs are stale — exactly what it
 *     exists to prevent — and `--sign` would then bake the truncation in permanently.
 *   - Under any OTHER key, indented continuation lines are skipped. Those are foreign
 *     to this gate (`hide:` / `extra:` are ordinary mkdocs-material directives), and
 *     rejecting them would fail a page for frontmatter that is none of our business.
 */
function parseFrontmatter(text, page) {
  // Tolerate CRLF so a Windows checkout does not fail every page; `.gitattributes`
  // pins these files to LF, so this is a belt-and-braces path.
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) throw new Error(`${page}: no frontmatter`);
  // Search from 3, not 4: `---\n---\n` is empty-but-terminated frontmatter, and starting
  // at 4 would step over its closing delimiter and misreport it as unterminated.
  const end = normalized.indexOf("\n---\n", 3);
  if (end === -1) throw new Error(`${page}: unterminated frontmatter`);
  const body = normalized.slice(4, end + 1);

  const fm = { sources: [] };
  let inSources = false;
  let inForeignBlock = false;
  for (const [i, line] of body.split("\n").entries()) {
    const where = `${page}:${i + 2}`;
    if (!line.trim()) continue;
    // A comment must not terminate a `sources:` block — that would silently truncate it.
    if (/^\s*#/.test(line)) continue;

    if (inSources) {
      const item = line.match(/^\s+-\s+(.*)$/);
      if (item) {
        fm.sources.push(item[1].trim().replace(/^["']|["']$/g, ""));
        continue;
      }
      // Not a list item and not a comment: the block ended. Only a new top-level key
      // may do that; anything else (a stray indent, a wrapped line) is an error below.
      inSources = false;
    }

    // A key we do not read opened a block list or nested mapping; its indented body is
    // not ours to validate. `sources:` never lands here — it sets inSources instead.
    if (inForeignBlock && /^\s/.test(line)) continue;
    inForeignBlock = false;

    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) {
      throw new Error(
        `${where}: cannot parse frontmatter line: ${line.trim()}\n` +
          `    (this gate reads flat \`key: value\` pairs plus a \`sources:\` block list)`,
      );
    }
    const [, key, rawValue] = kv;
    const value = rawValue.trim().replace(/^["']|["']$/g, "");

    // `>` / `|` block scalars would parse as the literal value ">" — truthy, and for
    // sources_exempt_reason that silently drops the page from the gate.
    if (/^[>|][0-9+-]*$/.test(value)) {
      throw new Error(`${where}: YAML block scalars are not supported; put \`${key}\` on one line`);
    }

    if (key === "sources") {
      if (value === "[]") fm.sources = [];
      else if (value === "") inSources = true;
      else throw new Error(`${where}: \`sources:\` must be \`[]\` or a block list`);
      continue;
    }
    // An empty value on a key we do not read opens a block we should ignore, not police.
    if (value === "") inForeignBlock = true;
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
 * a TRAILING `**` prefix-walk (`src/permissions/**`) and `*` within a single segment.
 *
 * `**` anywhere but the end is rejected rather than approximated: the obvious reading
 * of `src/**\/*.ts` is "the .ts files", but a prefix-walk returns every file under
 * `src/`, and a bare `**` prefix would walk the repo root and pull in .git/ and
 * node_modules/ — making the hash depend on untracked local state.
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
    if (!pattern.endsWith("/**") || pattern.indexOf("**") !== pattern.lastIndexOf("**")) {
      throw new Error(`\`**\` is only supported as a trailing prefix-walk (\`dir/**\`): ${pattern}`);
    }
    const base = pattern.slice(0, deep).replace(/\/$/, "");
    if (!base) throw new Error(`\`**\` needs a directory prefix: ${pattern}`);
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
    // Rewrite the whole line rather than string-matching the parsed value: the parser
    // strips quotes, so `sources_hash: "abc"` would never match `sources_hash: abc` and
    // the write would silently no-op while reporting success.
    const signed = fm.sources_hash
      ? text.replace(/^sources_hash:.*$/m, `sources_hash: ${actual}`)
      : text.replace(/^---\n/, `---\nsources_hash: ${actual}\n`);
    if (signed === text) {
      errors.push(`${page}: could not write sources_hash — the frontmatter is not in the expected shape`);
      continue;
    }
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
