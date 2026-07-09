import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config/load.js";
import { resolveAuthId } from "../src/permissions/catalog.js";

// Make the shipped examples part of the tested surface: each must load as a valid config, and
// every permission right it declares must resolve in the catalog. An unknown right name (e.g. a
// typo like "churchgroup:edit group members") fails the suite instead of only surfacing at plan time.
const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, "..", "examples");
const configFiles = readdirSync(examplesDir).filter((f) => f.endsWith(".config.ts"));

describe("examples/*.config.ts", () => {
  it("finds at least one example config to guard", () => {
    expect(configFiles.length).toBeGreaterThan(0);
  });

  it.each(configFiles)("%s loads and every permission right resolves in the catalog", async (file) => {
    const { permissions } = await loadConfig(join(examplesDir, file));
    for (const p of permissions) {
      for (const g of p.grants) {
        const name = typeof g === "string" ? g : g.right;
        expect(() => resolveAuthId(name), `${file}: right "${name}"`).not.toThrow();
      }
    }
  });
});
