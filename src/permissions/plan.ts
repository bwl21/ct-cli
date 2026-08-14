/**
 * The permission plan: resolve desired grants to (authId, dataId) tuples,
 * bulk-fetch actuals per distinct domainType, filter to managed domainIds
 * (the managed-guard — unmanaged domainIds are never surfaced or touched),
 * and diff. Mirrors `src/engine/build.ts`'s fetch-error handling.
 */
import { CtApiError } from "../api/ctClient.js";
import { fetchPermissionRows, type PermissionReader } from "./fetch.js";
import type { State } from "../state/state.js";
import type { DesiredResource } from "../engine/types.js";
import {
  resolveAuthId,
  CATALOG_META,
  CATALOG_IS_PER_INSTANCE,
  KNOWN_AUTH_IDS,
  SCOPE_FIELD_BY_AUTH_ID,
} from "./catalog.js";
import { compareVersions } from "../api/version.js";
import { resolveScope, resolveScopeRefs, type ScopeRefMap } from "./scope.js";
import {
  normalizeActual,
  diffGrants,
  type GrantTuple,
  type GrantDiff,
  type DomainType,
  type PreservePredicate,
  type RawPermission,
} from "./grants.js";
import type { DesiredPermission, PreserveUnknown } from "./types.js";
import { Resolver } from "../resolve/resolver.js";
import { isPendingRef, refKey, refLabel, type Ref } from "../resolve/refs.js";

/**
 * One resolved permission domain in the plan.
 *
 * `domainId` is the concrete numeric domain, EXCEPT when `pendingDomain` is set: the domain is a
 * logical Ref to a group type created in THIS SAME run (#69), whose id is unknown until the resource
 * tier applies. Then `domainId` is `null` and `pendingDomain` carries the Ref, re-resolved against
 * post-execute state at apply time (see `applyPermissionPlan`) — mirroring resource pending refs
 * (#20/#46) and the scope pending path (#29). A pending domain has no live grants yet, so its diff
 * is `desired → toPut` against an empty actual set.
 */
export interface PermissionPlanItem {
  key: string;
  domainType: DomainType;
  domainId: number | null;
  pendingDomain?: Ref;
  diff: GrantDiff;
}

/**
 * Fan out each grant to (authId, dataId) tuples. ChurchTools reads a scoped grant back as
 * ONE ROW PER dataId with a scalar `dataId` (see `normalizeActual`), so a desired tuple with
 * `dataId.length >= 2` can never equal any actual tuple and would churn forever. To match the
 * scalar read shape, a scoped grant `{right, scope:[a,b]}` becomes TWO single-dataId tuples,
 * not one two-element tuple.
 */
export function desiredTuples(
  p: DesiredPermission,
  state: State,
  declaredGroupKeys: ReadonlySet<string> = new Set(),
  scopeRefs: ScopeRefMap = new Map(),
): GrantTuple[] {
  return p.grants.flatMap((g): GrantTuple[] => {
    const name = typeof g === "string" ? g : g.right;
    const entry = resolveAuthId(name);
    if (typeof g === "string") {
      // A scoped right declared as a bare string would emit `dataId: []` — a silent GLOBAL grant.
      // Refuse it: a scoped right must be declared as `{ right, scope: [...] }` so the scope is explicit.
      if (entry.scopeField != null) {
        throw new Error(
          `${p.domainType} "${p.key}": "${name}" is a scoped right (scopeField "${entry.scopeField}") and must be declared as { right: "${name}", scope: [...] } — a bare string would grant it globally.`,
        );
      }
      return [{ authId: entry.authId, dataId: [], type: "grant" as const }];
    }
    if (entry.scopeField == null) {
      throw new Error(
        `${p.domainType} "${p.key}": "${name}" is not a scoped right (no scopeField) — remove "scope" or use a scoped right.`,
      );
    }
    // Retain the symbolic scopeKey (and its managed resource type, #98) on every scoped tuple so its
    // dataId is re-resolved against post-execute state at apply time. `id === null` means the target is
    // declared but not yet created (pending); it renders in the plan and always diffs into toPut (#29,
    // #33.3). A `numeric` resolution — the #49 escape hatch, or a typed ref that resolved through a live
    // master-data catalog rather than managed state — carries no state-backed key to re-resolve: its
    // dataId is already final, so no scopeKey is retained (apply.ts's `reresolveTuple` passes it as-is).
    const scoped = resolveScope(g.scope, state, declaredGroupKeys, {
      refs: scopeRefs,
      scopeField: entry.scopeField,
      where: `${p.domainType} "${p.key}" grant "${name}"`,
    });
    return scoped.map(({ key, id, numeric, type }) =>
      id === null
        ? {
            authId: entry.authId,
            dataId: [],
            type: "grant" as const,
            scopeKey: key,
            scopeType: type,
            pending: true,
          }
        : numeric
          ? { authId: entry.authId, dataId: [id], type: "grant" as const }
          : { authId: entry.authId, dataId: [id], type: "grant" as const, scopeKey: key, scopeType: type },
    );
  });
}

/**
 * Turn a declaration's `preserveUnknown` (#102) into the predicate `diffGrants` applies to every live
 * grant the declaration does not mention. `undefined` ⇒ no predicate ⇒ the strict default (revoke).
 *
 * The dimension of a live grant comes from its authId via the catalog. A grant whose authId the
 * catalog cannot name never reaches here — `buildPermissionPlan` already excludes those from the diff
 * entirely (they are warned about and left untouched, never revoked).
 */
export function preservePredicateFor(
  preserveUnknown: PreserveUnknown | undefined,
): PreservePredicate | undefined {
  if (preserveUnknown === undefined || preserveUnknown === false) return undefined;
  if (preserveUnknown === true) return () => true;
  const dimensions = new Set<string>(preserveUnknown);
  return (t) => {
    const scopeField = SCOPE_FIELD_BY_AUTH_ID.get(t.authId);
    // An UNSCOPED right (scopeField null) is never covered by a dimension list: the author named
    // dimensions to leave alone, and "no dimension" is not one of them. Preserving it would silently
    // widen the escape hatch past what was asked for.
    return scopeField != null && dimensions.has(scopeField);
  };
}

/**
 * A permission whose domainId has been resolved. Either a concrete numeric domain, or — when the
 * domain is a group type created in this same run (#69) — a `pendingDomain` Ref with `domainId: null`,
 * re-resolved at apply time.
 */
type ResolvedPermission =
  | (DesiredPermission & { domainId: number; pendingDomain?: undefined })
  | (Omit<DesiredPermission, "domainId"> & { domainId: null; pendingDomain: Ref });

/**
 * Resolve every permission's domainId (#20). A numeric domainId passes straight through; a Ref
 * (e.g. `groupType: "…"`) resolves against managed state ∪ the live catalog. A domainId that
 * resolves to a same-run-created resource (PendingRef) is NOT rejected (#69): it is carried as a
 * `pendingDomain` and re-resolved against post-execute state at apply time — this is what lets a
 * fresh-instance plan render the create-set + pending grants instead of aborting.
 *
 * That now includes a `group_role` domain on a group declared in this same config (#106). Its pairing
 * id needs a live `/groups/{id}/roles` fetch rather than a bare state lookup, so it is completed by
 * `applyPermissionPlan` (via `resolvePendingGroupRoleDomain`) instead of `reresolvePendingValue` — but
 * from the planner's side it is the same pending domain as any other. Before #106 it was a hard error,
 * which made any config declaring a group AND its own group-role plan on prod (where the group exists)
 * and fail on dev (where it does not) — non-portable by construction.
 *
 * The hard error remains ONLY for genuinely unresolvable references (key not in config/state at all).
 *
 * After resolution, the authoritative duplicate-target guard runs on the resolved identities (concrete
 * id, or the pending Ref's key): two different refs (or a ref and a number) that collide on one domain
 * would otherwise each diff against the other's grants and churn forever. Mirrors config/context.ts.
 */
async function resolveDomainIds(
  permissions: DesiredPermission[],
  resolver: Resolver,
): Promise<ResolvedPermission[]> {
  const resolved: ResolvedPermission[] = [];
  for (const p of permissions) {
    if (typeof p.domainId === "number") {
      resolved.push({ ...p, domainId: p.domainId });
      continue;
    }
    const site = `${p.domainType} "${p.key}".domainId`;
    // `pendingGroupRole` is opt-in per position (#106): this is the ONLY call site that can finish a
    // pending group_role, because `applyPermissionPlan` runs after `executePlan` and holds a client to
    // fetch the freshly created group's role list with.
    const res = await resolver.resolve(p.domainId, site, { pendingGroupRole: true });
    if (isPendingRef(res)) {
      resolved.push({
        key: p.key,
        domainType: p.domainType,
        grants: p.grants,
        preserveUnknown: p.preserveUnknown,
        domainId: null,
        pendingDomain: res.__pendingRef,
      });
      continue;
    }
    resolved.push({ ...p, domainId: res });
  }
  const seen = new Map<string, string>();
  for (const p of resolved) {
    const key = p.pendingDomain
      ? `${p.domainType}:pending:${refKey(p.pendingDomain)}`
      : `${p.domainType}:${p.domainId}`;
    const label = p.pendingDomain ? `<${refLabel(p.pendingDomain)}>` : `#${p.domainId}`;
    const prev = seen.get(key);
    if (prev) {
      throw new Error(
        `Duplicate permission target after resolution: ${p.domainType} ${label} is declared by ` +
          `both "${prev}" and "${p.key}". Merge their grants into one declaration.`,
      );
    }
    seen.set(key, p.key);
  }
  return resolved;
}

export async function buildPermissionPlan(
  client: PermissionReader,
  state: State,
  permissions: DesiredPermission[],
  desired: DesiredResource[] = [],
  resolver?: Resolver,
  instanceVersion?: string,
): Promise<{ items: PermissionPlanItem[]; fetchErrors: string[]; warnings: string[] }> {
  const items: PermissionPlanItem[] = [];
  const fetchErrors: string[] = [];
  const warnings: string[] = [];
  // Catalog staleness (#25/#105): the catalog is a snapshot captured against one CT version. If the
  // live instance reports a different version, right names/authIds/scopeFields may have drifted —
  // warn (never fail) so the diff is trusted-but-verified.
  //
  // The remediation now names a command a consumer repo can actually run (#105) — the old text
  // pointed at a script that only exists in this repo, so the warning was unactionable where printed.
  //
  // A per-instance capture is authoritative for its host AT CAPTURE TIME, not forever: the instance
  // gets upgraded while the committed file does not. So the version is compared either way; only the
  // wording differs, because "re-capture" and "capture one" are different asks.
  if (
    permissions.length > 0 &&
    instanceVersion &&
    CATALOG_META &&
    compareVersions(instanceVersion, CATALOG_META.ctVersion) !== 0
  ) {
    warnings.push(
      CATALOG_IS_PER_INSTANCE
        ? `Permission catalog for this host was captured against ChurchTools ${CATALOG_META.ctVersion} ` +
            `but the instance now runs ${instanceVersion}. Right names/authIds may have drifted since — ` +
            `re-capture with \`ct permissions catalog --refresh\` (see docs/handbuch/permissions.md).`
        : `Permission catalog was captured from ChurchTools ${CATALOG_META.ctVersion} but this instance ` +
            `runs ${instanceVersion}. Right names/authIds may be stale — capture one for this instance ` +
            `with \`ct permissions catalog --refresh\` (see docs/handbuch/permissions.md).`,
    );
  }
  // Resolve logical domainIds (#20) up front. Shares the command layer's resolver so master-data
  // catalogs are fetched once across buildPlan + buildPermissionPlan; falls back to a private one.
  const refResolver = resolver ?? new Resolver({ client, state, desired });
  const resolved = await resolveDomainIds(permissions, refResolver);
  // Typed logical scope refs (#98) resolve — and are dimension-checked against each right's
  // scopeField — in one async pass here, so the per-grant `resolveScope` below stays synchronous.
  const scopeRefs = await resolveScopeRefs(permissions, refResolver, state);
  // Keys declared as groups in the config — valid scope targets even before they are created.
  const declaredGroupKeys = new Set(desired.filter((r) => r.type === "group").map((r) => r.key));
  // one bulk fetch per distinct domainType — but only for CONCRETE domains. A pending domain (#69)
  // is a group type created this run: it has no live grants, so nothing to fetch (and on a fresh
  // instance the fetch would be a pure waste, or a spurious fetchError).
  const byType = new Map<DomainType, RawPermission[] | null>();
  for (const dt of new Set(resolved.filter((p) => p.pendingDomain === undefined).map((p) => p.domainType))) {
    try {
      byType.set(dt, await fetchPermissionRows(client, `/permissions/${dt}`));
    } catch (err) {
      const message = err instanceof CtApiError ? `${err.status}` : (err as Error).message;
      fetchErrors.push(`permissions ${dt}: ${message}`);
      byType.set(dt, null);
    }
  }
  for (const p of resolved) {
    if (p.pendingDomain !== undefined) {
      // The domain (a group type, a person status, or the group behind a group_role — #106) is created
      // THIS run (#69), so it has no live grants yet: the actual set is empty and every desired grant
      // lands in toPut as a pending grant block. Its numeric domainId is unknown until the resource
      // tier applies — the pending marker is completed at apply time (applyPermissionPlan). Rendered
      // with a `<groupType:x (created this apply)>` marker consistent with resource pending refs.
      items.push({
        key: p.key,
        domainType: p.domainType,
        domainId: null,
        pendingDomain: p.pendingDomain,
        // domainId is irrelevant to desiredTuples (it only reads key/domainType/grants); pass the
        // pending Ref through so the shape stays a valid DesiredPermission.
        diff: diffGrants(
          desiredTuples({ ...p, domainId: p.pendingDomain }, state, declaredGroupKeys, scopeRefs),
          [],
        ),
      });
      continue;
    }
    const all = byType.get(p.domainType);
    if (all == null) continue; // fetch failed for this domainType — recorded above
    const normalizedAll = normalizeActual(all.filter((r) => r.domainId === p.domainId));
    // Actuals are already filtered by `normalizeActual`: the self-re-adding system baseline
    // (`modifiedPid === -1`) and every `isInherited` row are dropped, so what remains is admin-authored
    // DIRECT grants — INCLUDING the writable `authId >= 10000` group-member rights Equippers curates on
    // group_type_role (e.g. "Add group members" 10107). Those are reconciled like any other grant; there
    // is no authId cutoff (see grants.ts — the old `authId >= 10000` exclusion was too broad, #65).
    //
    // Unknown-authId guard (#25): a live GRANT whose authId is absent from the catalog cannot be
    // named or described. Keep it OUT of the diff — otherwise, having no desired counterpart, it
    // would land in `toDelete` and `ct apply` would silently revoke a right we cannot even name.
    // Instead, warn (naming authId + domain) and leave it untouched. Idempotent: excluded every run.
    // (Revoke/deny rows with an unknown authId are already `preserved` by diffGrants, so ignore them
    // here — only unknown grant rows are the churn/silent-revoke hazard.)
    const knownActual: GrantTuple[] = [];
    const unknownAuthIds = new Set<number>();
    for (const t of normalizedAll) {
      if (t.type === "grant" && !KNOWN_AUTH_IDS.has(t.authId)) {
        unknownAuthIds.add(t.authId);
        continue;
      }
      knownActual.push(t);
    }
    for (const authId of [...unknownAuthIds].sort((a, b) => a - b)) {
      warnings.push(
        `${p.domainType} #${p.domainId} ("${p.key}"): a live grant carries authId ${authId}, which is ` +
          `not in the permission catalog — left untouched (never revoked). Capture this instance's own ` +
          `catalog (\`ct permissions catalog --refresh\`) if this right should be manageable.`,
      );
    }
    items.push({
      key: p.key,
      domainType: p.domainType,
      domainId: p.domainId,
      diff: diffGrants(
        desiredTuples(p, state, declaredGroupKeys, scopeRefs),
        knownActual,
        preservePredicateFor(p.preserveUnknown),
      ),
    });
  }
  return { items, fetchErrors, warnings };
}
