/**
 * Registry of adoptable ChurchTools resource types.
 *
 * Each entry knows how to fetch one resource by id, derive a stable logical key,
 * snapshot the fields we manage, and render a config snippet (the TS-as-code
 * form the Phase 3 engine will consume). Paths come from the Phase 0 coverage
 * matrix (docs/api-coverage.md). Adding a type = adding an entry here.
 */

export interface AdoptableResource {
  /** Collection path: `POST` here creates. */
  collectionPath: string;
  /** GET/PUT/PATCH/DELETE path for a single resource by id. */
  itemPath: (id: number) => string;
  /** Update verb: `group` is PATCH; every other type is PUT. */
  updateMethod: "PUT" | "PATCH";
  /**
   * Apply tier: lower applies first, delete runs highest first (see engine/graph.ts). Owned here so
   * a new resource type declares its ordering in the same place as its paths — `engine/graph.ts`
   * derives `TYPE_TIER` from these entries instead of maintaining a parallel (drift-prone) table.
   */
  tier: number;
  /** Stable logical key derived from the fetched resource. */
  deriveKey: (resource: Record<string, unknown>) => string;
  /** The subset of fields we manage — the desired-state baseline. */
  managedFields: (resource: Record<string, unknown>) => Record<string, unknown>;
  /**
   * DSL function name `configSnippet` emits for this type. Defaults to the camelCase of
   * the type name. Set it when the natural camelCase collides with another DSL surface
   * (e.g. `group-role` → `roleDefinition`, because `groupRole` is the permission function).
   */
  dslName?: string;
}

/** Build a full spec, deriving `itemPath` from the collection path so each entry names its path once. */
function define(spec: Omit<AdoptableResource, "itemPath">): AdoptableResource {
  return { ...spec, itemPath: (id: number) => `${spec.collectionPath}/${id}` };
}

/**
 * kebab/underscore slug: "Kids Leitung" → "kids_leitung", "Zürich" → "zurich".
 * NFKD splits accented letters into base + combining mark; we drop the marks so
 * German names (ü/ö/ä/…) slug to their base letters rather than gaining a `_`.
 */
export function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function str(resource: Record<string, unknown>, key: string): string {
  const value = resource[key];
  return typeof value === "string" ? value : "";
}

/** Read a field, preferring a nested `information` object but falling back to the top level. */
function fromInformation(resource: Record<string, unknown>, key: string): unknown {
  const information = (resource.information as Record<string, unknown> | undefined) ?? {};
  return information[key] ?? resource[key];
}

export const RESOURCES: Record<string, AdoptableResource> = {
  campus: define({
    collectionPath: "/campuses",
    updateMethod: "PUT",
    tier: 0,
    // CT's campus short name is `shorty` (1–10 chars, required on create) — verified
    // live. `shortName` is a vestigial, usually-null sibling; do not use it for writes.
    deriveKey: (r) => slug(str(r, "shorty") || str(r, "name")),
    managedFields: (r) => ({ name: r.name, shorty: r.shorty }),
  }),
  group: define({
    collectionPath: "/groups",
    updateMethod: "PATCH",
    tier: 1,
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({
      name: r.name,
      groupTypeId: fromInformation(r, "groupTypeId"),
      groupStatusId: fromInformation(r, "groupStatusId"),
    }),
  }),
  "group-type": define({
    collectionPath: "/group/grouptypes",
    updateMethod: "PUT",
    tier: 0,
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ name: r.name, nameTranslated: r.nameTranslated }),
  }),
  "age-group": define({
    collectionPath: "/group/agegroups",
    updateMethod: "PUT",
    tier: 0,
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ name: r.name, nameTranslated: r.nameTranslated, sortKey: r.sortKey }),
  }),
  "target-group": define({
    collectionPath: "/group/targetgroups",
    updateMethod: "PUT",
    tier: 0,
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ name: r.name, nameTranslated: r.nameTranslated, sortKey: r.sortKey }),
  }),
  "relationship-type": define({
    collectionPath: "/person/relationshiptypes",
    updateMethod: "PUT",
    tier: 0,
    deriveKey: (r) => slug(str(r, "name")),
    // CT names the two ends degreeNameA/degreeNameB (verified live) — not degreeForward/Reverse.
    managedFields: (r) => ({
      name: r.name,
      nameTranslated: r.nameTranslated,
      degreeNameA: r.degreeNameA,
      degreeNameB: r.degreeNameB,
    }),
  }),
  "group-role": define({
    collectionPath: "/group/roles",
    updateMethod: "PUT",
    tier: 3,
    deriveKey: (r) => slug(str(r, "name")),
    managedFields: (r) => ({ name: r.name, nameTranslated: r.nameTranslated, groupTypeId: r.groupTypeId }),
    // `groupRole` is taken by the permissions DSL (`ct.groupRole` = definePermission("group_role")),
    // so the master-data role resource declares under a distinct name.
    dslName: "roleDefinition",
  }),
};

export function resourceType(type: string): AdoptableResource {
  const entry = RESOURCES[type];
  if (!entry) {
    const known = Object.keys(RESOURCES).join(", ");
    throw new Error(`Unknown resource type "${type}". Adoptable types: ${known}.`);
  }
  return entry;
}

/** Camel-case a hyphenated type name: `group-type` → `groupType`. */
function camelCase(type: string): string {
  return type.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Render a config entry as a TS-as-code call, e.g. `campus({ key: "mainz", name: "Mainz" })`.
 * The function name comes from the registry entry's `dslName` (default: camelCase of the type),
 * so the emitted snippet always names an actual `ConfigContext` function — never a colliding one.
 */
export function configSnippet(type: string, key: string, fields: Record<string, unknown>): string {
  const fn = RESOURCES[type]?.dslName ?? camelCase(type);
  return `${fn}(${tsObject({ key, ...fields })});`;
}

function tsObject(obj: Record<string, unknown>): string {
  const parts = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${isIdentifier(k) ? k : JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{ ${parts.join(", ")} }`;
}

function isIdentifier(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}
