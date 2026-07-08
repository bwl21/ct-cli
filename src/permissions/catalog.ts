/**
 * The permission catalog: the static name→authId bridge (see src/permissions/README.md).
 * The catalog is reference data captured from the instance's churchauth masterdata; it is
 * NOT available via the REST API, so it is shipped as JSON and read from disk once.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface CatalogEntry { authId: number; scopeField: string | null; revocable: boolean; desc: string }

let cache: Record<string, CatalogEntry> | null = null;

export function loadCatalog(): Record<string, CatalogEntry> {
  if (cache) return cache;
  const here = dirname(fileURLToPath(import.meta.url));
  cache = JSON.parse(readFileSync(join(here, "catalog.json"), "utf8")) as Record<string, CatalogEntry>;
  return cache;
}

export function resolveAuthId(name: string): CatalogEntry {
  const entry = loadCatalog()[name];
  if (!entry) {
    const [mod] = name.split(":");
    const near = Object.keys(loadCatalog()).filter((k) => k.startsWith(`${mod}:`)).slice(0, 6);
    const hint = near.length ? ` Did you mean one of: ${near.join(", ")}?` : "";
    throw new Error(`Unknown permission "${name}".${hint}`);
  }
  return entry;
}
