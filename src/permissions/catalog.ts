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
 * Provenance for the catalog (#25). Recorded as a reserved top-level `$meta` key in catalog.json so
 * `ct plan` can warn when the live instance's CT version drifts from the version this catalog was
 * captured against (authIds/scopeFields may then be stale). The key is split out below so it is
 * NEVER seen as a right by any catalog consumer (`resolveAuthId`, `ct get permissions-catalog`,
 * grant adoption) — they all iterate {@link CATALOG}, which excludes it.
 */
export interface CatalogMeta {
  /** Host the catalog was captured from (informational). */
  capturedFrom: string;
  /** ChurchTools version at capture time, e.g. "3.134.0" — compared to the live instance at plan time. */
  ctVersion: string;
  /** ISO date of capture. */
  capturedAt: string;
  /** Number of rights captured (sanity check). */
  rightCount: number;
  [k: string]: unknown;
}

// Split the reserved `$meta` provenance key from the rights. Done once at module load so every
// consumer of CATALOG sees rights only, and metadata is available without a second parse.
const { $meta, ...rights } = catalogData as unknown as { $meta?: CatalogMeta } & Record<string, CatalogEntry>;

/**
 * The permission catalog: name → authId bridge, inlined at build time (see the module header).
 * It is a constant, not something "loaded" — callers that need a snapshot already spread it, so it
 * is exported directly rather than behind a `loadCatalog()` wrapper. Excludes the `$meta` key.
 */
export const CATALOG = rights as Record<string, CatalogEntry>;

/** The catalog's recorded provenance (#25), or `null` on a legacy catalog with no `$meta` key. */
export const CATALOG_META: CatalogMeta | null = $meta ?? null;

/**
 * Every authId the catalog knows a name for. `ct plan` uses this to detect a live grant carrying an
 * authId the catalog cannot name (a stale/foreign right) — such a grant is warned about and left
 * untouched, never revoked, because we cannot even describe what we would be deleting (#25).
 */
export const KNOWN_AUTH_IDS: ReadonlySet<number> = new Set(
  Object.values(CATALOG).map((e) => e.authId),
);

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
