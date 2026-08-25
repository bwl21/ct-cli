import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function typescriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return nested.flat();
}

/**
 * Every module specifier a file pulls in: static `from "…"`, side-effect `import "…"`, and
 * dynamic `import("…")`. The `from`-only version missed the latter two, so a boundary could be
 * crossed by an `await import()` with the rule still green.
 */
function imports(source: string): string[] {
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].flatMap((m) => (m[1] ? [m[1]] : [])));
}

/** Resolve a relative `./x.js` specifier back to the `.ts` file it is compiled from. */
async function resolveLocal(fromFile: string, specifier: string): Promise<string | null> {
  if (!specifier.startsWith(".")) return null;
  const target = join(dirname(fromFile), specifier.replace(/\.js$/, ".ts"));
  try {
    await readFile(target, "utf8");
    return target;
  } catch {
    return null;
  }
}

/** Every `.ts` file reachable from `entries` by following relative imports. */
async function reachableFrom(entries: string[]): Promise<Set<string>> {
  const seen = new Set(entries);
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift()!;
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const specifier of imports(source)) {
      const target = await resolveLocal(file, specifier);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
}

describe("application architecture boundaries", () => {
  it("keeps the application layer independent of presentation and transport adapters", async () => {
    const files = await typescriptFiles(join(root, "src/application"));
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const specifier of imports(source)) {
        const bare = specifier.split("/")[0];
        if (
          ["commander", "hono", "vue"].includes(bare!) ||
          /(^|\/)commands\//.test(specifier) ||
          /(^|\/)server\//.test(specifier) ||
          /(^|\/)web\//.test(specifier) ||
          /(^|\/)ui(?:\/|\.js$)/.test(specifier)
        ) {
          violations.push(`${relative(root, file)} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  /**
   * The direct-import rule above only looks one hop deep, so it stayed green while the layer
   * reached the terminal presenter transitively — which is how `warn()` inside plan building
   * would write to a future server's stderr instead of returning a warning (#156 review).
   *
   * These modules print directly and are reachable from `src/application`. They pre-date the
   * extraction, so they are pinned rather than asserted away: the list can only shrink, and a
   * NEW module that both prints and is pulled into the application layer fails here.
   */
  it("pins every module that prints and is reachable from the application layer", async () => {
    const entries = await typescriptFiles(join(root, "src/application"));
    const reachable = await reachableFrom(entries);
    const printers: string[] = [];
    for (const file of reachable) {
      if (file.startsWith(join(root, "src/application"))) continue;
      const source = await readFile(file, "utf8");
      for (const specifier of imports(source)) {
        if ((await resolveLocal(file, specifier)) === join(root, "src/ui.ts")) {
          printers.push(relative(root, file));
          break;
        }
      }
    }
    expect(printers.sort()).toEqual([
      "src/auth/status.ts",
      "src/config/context.ts",
      "src/engine/build.ts",
      "src/engine/execute.ts",
      "src/engine/synthetic.ts",
      "src/permissions/apply.ts",
      "src/permissions/masterdata.ts",
    ]);
  });

  it("pins the existing CLI mutation imports so no new adapter bypass is introduced", async () => {
    const files = await typescriptFiles(join(root, "src/commands"));
    const guarded = ["executePlan", "saveState", "writeBackup", "applyPermissionPlan"];
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const symbol of guarded) {
        if (new RegExp(`\\b${symbol}\\b`).test(source)) {
          violations.push(`${relative(root, file)}:${symbol}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps the HTTP adapter behind application operations", async () => {
    const files = await typescriptFiles(join(root, "src/server"));
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const specifier of imports(source)) {
        if (/\.\.\/(?:api|engine|permissions|state|auth|config|env|resources)(?:\/|\.js$)/.test(specifier)) {
          violations.push(`${relative(root, file)} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
