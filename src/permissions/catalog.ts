/**
 * The permission catalog: the static name→authId bridge (see src/permissions/README.md).
 * The catalog is reference data captured from the instance's churchauth masterdata; it is
 * NOT available via the REST API, so it is shipped as JSON.
 *
 * Imported (not `readFileSync`'d) so tsup/esbuild inlines it into the bundle at build time —
 * `dist/index.js` needs no sibling `catalog.json` on disk, avoiding an ENOENT in the packaged
 * binary (tsup does not copy non-entry assets into `dist/` on its own).
 */
import catalogData from "./catalog.json" with { type: "json" };

export interface CatalogEntry { authId: number; scopeField: string | null; revocable: boolean; desc: string }

/**
 * The permission catalog: name → authId bridge, inlined at build time (see the module header).
 * It is a constant, not something "loaded" — callers that need a snapshot already spread it, so it
 * is exported directly rather than behind a `loadCatalog()` wrapper.
 */
export const CATALOG = catalogData as Record<string, CatalogEntry>;

export function resolveAuthId(name: string): CatalogEntry {
  const entry = CATALOG[name];
  if (!entry) {
    const [mod] = name.split(":");
    const near = Object.keys(CATALOG).filter((k) => k.startsWith(`${mod}:`)).slice(0, 6);
    const hint = near.length ? ` Did you mean one of: ${near.join(", ")}?` : "";
    throw new Error(`Unknown permission "${name}".${hint}`);
  }
  return entry;
}
