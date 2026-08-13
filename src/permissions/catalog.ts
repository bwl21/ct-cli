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

export interface CatalogEntry {
  authId: number;
  scopeField: string | null;
  revocable: boolean;
  desc: string;
}

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

/** Split the reserved `$meta` provenance key from the rights, so no consumer sees it as a right. */
function splitCatalog(data: unknown): { rights: Record<string, CatalogEntry>; meta: CatalogMeta | null } {
  const { $meta, ...rights } = data as { $meta?: CatalogMeta } & Record<string, CatalogEntry>;
  return { rights, meta: $meta ?? null };
}

const bundled = splitCatalog(catalogData);

/**
 * The permission catalog: name → authId bridge. Bundled at build time (see the module header), and
 * REPLACEABLE at runtime by a per-instance capture (#105 — see {@link useCatalog}).
 *
 * `let`, not `const`, because ESM exports are live bindings: every module that did
 * `import { CATALOG }` sees the swap without any of them having to learn that a catalog can be
 * loaded. That keeps the "one static catalog" reading of this module intact everywhere it is used,
 * while the command layer gets to point it at a fresher one.
 */
export let CATALOG: Record<string, CatalogEntry> = bundled.rights;

/** The catalog's recorded provenance (#25), or `null` on a legacy catalog with no `$meta` key. */
export let CATALOG_META: CatalogMeta | null = bundled.meta;

/**
 * True once a capture taken from the TARGET instance itself has been loaded (#105). Such a catalog is
 * authoritative for that host, so the version-skew warning — which exists to flag "this snapshot came
 * from a different ChurchTools than you are planning against" — has nothing left to say and stays
 * quiet. False while the bundled snapshot is active.
 */
export let CATALOG_IS_PER_INSTANCE = false;

/**
 * Every authId the catalog knows a name for. `ct plan` uses this to detect a live grant carrying an
 * authId the catalog cannot name (a stale/foreign right) — such a grant is warned about and left
 * untouched, never revoked, because we cannot even describe what we would be deleting (#25).
 */
export let KNOWN_AUTH_IDS: ReadonlySet<number> = new Set(Object.values(CATALOG).map((e) => e.authId));

/**
 * authId → the scope dimension (`scopeField`) that right is scoped by, or `null` for an unscoped
 * right. The inverse of the name-keyed catalog. Used wherever a LIVE grant — which carries an authId
 * and no name — must be classified by dimension: `preserveUnknown` (#102) and the declarability
 * verdict in `ct coverage` (#103). An authId absent from the map is a right the catalog cannot name.
 */
export let SCOPE_FIELD_BY_AUTH_ID: ReadonlyMap<number, string | null> = new Map(
  Object.values(CATALOG).map((e) => [e.authId, e.scopeField] as const),
);

/**
 * Every distinct scope dimension the catalog knows, for validating an author-supplied dimension list
 * (`preserveUnknown: ["cc_html_template"]`, #102). A typo there would otherwise preserve nothing and
 * look identical to "there was nothing to preserve".
 */
export let KNOWN_SCOPE_FIELDS: ReadonlySet<string> = new Set(
  Object.values(CATALOG)
    .map((e) => e.scopeField)
    .filter((f): f is string => f != null),
);

/**
 * Point every catalog consumer at a different capture (#105). Used by the per-instance catalog
 * (`.ct/permission-catalog.<host>.json`) so a consumer repo can act on the staleness warning without
 * waiting for a release of this package — the bundled catalog is a snapshot of ONE instance's
 * ChurchTools version, and the warning that told people to regenerate it named a script that only
 * exists in this repo.
 *
 * Every derived index is rebuilt here, so the whole module stays internally consistent — there is no
 * path that leaves `KNOWN_AUTH_IDS` describing the old catalog.
 */
export function useCatalog(data: unknown, opts: { perInstance?: boolean } = {}): void {
  const next = splitCatalog(data);
  CATALOG_IS_PER_INSTANCE = opts.perInstance ?? false;
  CATALOG = next.rights;
  CATALOG_META = next.meta;
  KNOWN_AUTH_IDS = new Set(Object.values(CATALOG).map((e) => e.authId));
  SCOPE_FIELD_BY_AUTH_ID = new Map(Object.values(CATALOG).map((e) => [e.authId, e.scopeField] as const));
  KNOWN_SCOPE_FIELDS = new Set(
    Object.values(CATALOG)
      .map((e) => e.scopeField)
      .filter((f): f is string => f != null),
  );
}

/** Restore the catalog bundled with this release. Exists so tests can undo {@link useCatalog}. */
export function useBundledCatalog(): void {
  useCatalog(catalogData);
}

export function resolveAuthId(name: string): CatalogEntry {
  const entry = CATALOG[name];
  if (!entry) {
    const [mod] = name.split(":");
    const near = Object.keys(CATALOG)
      .filter((k) => k.startsWith(`${mod}:`))
      .slice(0, 6);
    const hint = near.length ? ` Did you mean one of: ${near.join(", ")}?` : "";
    throw new Error(`Unknown permission "${name}".${hint}`);
  }
  return entry;
}
