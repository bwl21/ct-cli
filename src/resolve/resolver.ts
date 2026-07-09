/**
 * The per-host reference resolver (#20). Turns logical {@link Ref}s into numeric
 * ChurchTools ids, sourced (in order) from:
 *
 *  1. Managed desired ∪ state, by logical key. A key that names a managed resource
 *     in state resolves to its id; a key declared in this config but not yet in
 *     state resolves to a {@link PendingRef} (its id is only known after the
 *     resource tier applies — re-resolved at apply time, mirroring the permission
 *     scope pattern in src/permissions/scope.ts).
 *  2. Live catalog master data, matched by `slug(name) === key` with an exact-name
 *     secondary: campus → /campuses, group-type → /group/grouptypes,
 *     group-status → /group/memberstatus, role-def → /group/roles. Each catalog is
 *     fetched at most once per run and cached by a `Map<RefKind, Promise>`, so the
 *     resolver is safe to share across `buildPlan` and `buildPermissionPlan` running
 *     concurrently (both await the same in-flight promise).
 *  3. Hard error naming the kind, key, referencing site, and host.
 *
 * Unknown / ambiguous references THROW (a config error — distinct from the
 * degrade-and-continue fetchErrors path). Resolved ids are never written back to
 * config; only state carries ids.
 */
import type { CtClient } from "../api/ctClient.js";
import type { State } from "../state/state.js";
import type { DesiredResource } from "../engine/types.js";
import { slug } from "../resources/registry.js";
import {
  collectRefs,
  deepMapRefs,
  isPendingRef,
  isRef,
  pendingRef,
  refKey,
  refLabel,
  type GroupRoleRef,
  type PendingRef,
  type Ref,
  type RefKind,
  type SimpleRef,
} from "./refs.js";

/** ref kind → managed resource type (state/desired). group-status is read-only master data (catalog only). */
const REF_KIND_TYPE: Partial<Record<RefKind, string>> = {
  campus: "campus",
  "group-type": "group-type",
  "role-def": "group-role",
  group: "group",
};

/** ref kind → live catalog path. `group` has no catalog (managed-only); `group-role` is gated. */
const CATALOG_PATH: Partial<Record<RefKind, string>> = {
  campus: "/campuses",
  "group-type": "/group/grouptypes",
  // Assumption (documented): /group/memberstatus rows carry a `name` field, like every other
  // master-data catalog here (campus/grouptype/role all expose `name`). The endpoint is GET-only
  // (docs/api-coverage.md #8), so this is matched, never written. If a live instance names the
  // field differently, resolution falls through to the exact-name secondary and then a hard error.
  "group-status": "/group/memberstatus",
  "role-def": "/group/roles",
};

interface CatalogRecord {
  id: number;
  name?: string;
  [k: string]: unknown;
}

export interface ResolverDeps {
  client: Pick<CtClient, "get">;
  state: State;
  desired: DesiredResource[];
  /** Host label for error messages. Defaults to `state.host`. */
  host?: string;
}

/**
 * GATED (#20/#25): resolve a (group, role) pair to CT's internal group_role pairing domainId.
 * TODO(#25): the candidate source is `GET /groups/{groupId}/roles` (per-group role assignments),
 * but the pairing id is NOT confirmed to be exposed there — verify live on eqrm-dev before wiring
 * this up. Until then the resolver rejects group_role refs with a clear "pass a numeric id" error;
 * this seam exists so the lookup can be dropped in without touching call sites.
 */
export async function lookupGroupRolePairing(
  groupId: number,
  roleId: number,
  client: Pick<CtClient, "get">,
): Promise<number> {
  // Reference the seam's inputs so the intended call shape is documented in one place:
  //   const roles = await client.get(`/groups/${groupId}/roles`); find the row for `roleId`; its
  //   pairing id is the group_role domainId — IF the endpoint exposes it (unconfirmed).
  void client;
  throw new Error(
    `group_role (group ${groupId}, role ${roleId}) → domainId lookup is not implemented (#25).`,
  );
}

export class Resolver {
  private readonly client: Pick<CtClient, "get">;
  private readonly state: State;
  private readonly host: string;
  private readonly catalogs = new Map<RefKind, Promise<CatalogRecord[]>>();
  /** Declared logical keys indexed by resource type — a same-run target that resolves to pending. */
  private readonly declaredByType = new Map<string, Set<string>>();

  constructor(deps: ResolverDeps) {
    this.client = deps.client;
    this.state = deps.state;
    this.host = deps.host ?? deps.state.host;
    for (const d of deps.desired) {
      let set = this.declaredByType.get(d.type);
      if (!set) {
        set = new Set();
        this.declaredByType.set(d.type, set);
      }
      set.add(d.key);
    }
  }

  /** Resolve one Ref to a numeric id, or a {@link PendingRef} for a same-run-created managed target. */
  async resolve(r: Ref, site: string): Promise<number | PendingRef> {
    if (r.kind === "group-role") return this.resolveGroupRole(r, site);
    // (1) managed desired ∪ state by logical key
    const type = REF_KIND_TYPE[r.kind];
    if (type !== undefined) {
      const managed = this.state.resources[r.key];
      if (managed && managed.type === type) return managed.id;
      if (this.declaredByType.get(type)?.has(r.key)) return pendingRef(r);
    }
    // (2) live catalog
    if (CATALOG_PATH[r.kind] !== undefined) return this.resolveFromCatalog(r, site);
    // (3) hard error
    throw this.notFound(r, site);
  }

  /**
   * Deep-rewrite every Ref embedded in `value` to its resolved id / pending marker. Returns the
   * original reference unchanged when it holds no Refs (numbers pass through untouched — the numeric
   * escape hatch — so a fully-numeric field bag is never rebuilt and diffs number↔number).
   */
  async resolveValue(value: unknown, site: string): Promise<unknown> {
    const refs = collectRefs(value);
    if (refs.length === 0) return value;
    const byKey = new Map<string, number | PendingRef>();
    for (const r of refs) {
      const k = refKey(r);
      if (!byKey.has(k)) byKey.set(k, await this.resolve(r, site));
    }
    return deepMapRefs(value, (r) => byKey.get(refKey(r)));
  }

  private catalog(kind: RefKind): Promise<CatalogRecord[]> {
    let p = this.catalogs.get(kind);
    if (!p) {
      const path = CATALOG_PATH[kind]!;
      p = this.client.get<CatalogRecord[]>(path).then((rows) => (Array.isArray(rows) ? rows : []));
      this.catalogs.set(kind, p);
    }
    return p;
  }

  private async resolveFromCatalog(r: SimpleRef, site: string): Promise<number> {
    const rows = await this.catalog(r.kind);
    const pick = (candidates: CatalogRecord[]): number => {
      if (candidates.length > 1) throw this.ambiguous(r, site, candidates);
      return candidates[0]!.id;
    };
    // Primary: slugified name. Secondary: exact (case-sensitive) name — covers a name that does not
    // survive slugging cleanly. Ambiguity in either bucket is a hard error listing the candidates.
    const bySlug = rows.filter((row) => typeof row.name === "string" && slug(row.name) === r.key);
    if (bySlug.length >= 1) return pick(bySlug);
    const byExact = rows.filter((row) => row.name === r.key);
    if (byExact.length >= 1) return pick(byExact);
    throw this.notFound(r, site);
  }

  private resolveGroupRole(r: GroupRoleRef, site: string): never {
    throw new Error(
      `Cannot resolve ${refLabel(r)} referenced at ${site} on ${this.host}: resolving a ` +
        `(group, role) pair to its permission domainId is not yet supported — pass a numeric id ` +
        `instead (see #25).`,
    );
  }

  private notFound(r: SimpleRef, site: string): Error {
    const catalog = CATALOG_PATH[r.kind];
    const where = catalog
      ? `no managed resource and no live ${r.kind} at ${catalog} matches key "${r.key}"`
      : `no managed ${r.kind} named "${r.key}" is declared or adopted`;
    return new Error(
      `Cannot resolve ${refLabel(r)} referenced at ${site} on ${this.host}: ${where}. ` +
        `Declare/adopt it, fix the key/name, or use a numeric id.`,
    );
  }

  private ambiguous(r: SimpleRef, site: string, candidates: CatalogRecord[]): Error {
    const list = candidates.map((c) => `${JSON.stringify(c.name)} (#${c.id})`).join(", ");
    return new Error(
      `Ambiguous ${refLabel(r)} referenced at ${site} on ${this.host}: ${candidates.length} live ` +
        `${r.kind}s match — ${list}. Rename to disambiguate, or use a numeric id.`,
    );
  }
}

/**
 * Re-resolve every {@link PendingRef} in a value against the POST-execute state, at apply time.
 * The referenced resource's tier applies before the referencing resource's (campus tier 0 < group
 * tier 1), so its id is guaranteed present in state by the time the referencing body is built —
 * analogous to the permission scope `reresolveTuple`. Passes non-pending values through untouched.
 */
export function reresolvePendingValue(value: unknown, state: State): unknown {
  if (isPendingRef(value)) return pendingIdFromState(value.__pendingRef, state);
  if (Array.isArray(value)) return value.map((v) => reresolvePendingValue(v, state));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = reresolvePendingValue(v, state);
    return out;
  }
  return value;
}

function pendingIdFromState(r: Ref, state: State): number {
  if (r.kind === "group-role") {
    // group_role refs are gated at plan time, so a pending one should never reach apply.
    throw new Error(`Pending ${refLabel(r)} reached apply — group_role refs are unsupported (#25).`);
  }
  const managed = state.resources[r.key];
  if (!managed) {
    throw new Error(
      `Pending reference ${refLabel(r)} did not resolve after apply — "${r.key}" is not in state. ` +
        `Its tier should have applied first.`,
    );
  }
  return managed.id;
}

/** Re-export for callers that only need the guard without importing refs.ts directly. */
export { isRef };
