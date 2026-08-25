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

function imports(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].flatMap((match) => (match[1] ? [match[1]] : []));
}

describe("application architecture boundaries", () => {
  it("keeps the application layer independent of presentation and transport adapters", async () => {
    const files = await typescriptFiles(join(root, "src/application"));
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const specifier of imports(source)) {
        if (
          ["commander", "hono", "vue"].includes(specifier) ||
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
