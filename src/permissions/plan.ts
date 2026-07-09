/**
 * The permission plan: resolve desired grants to (authId, dataId) tuples,
 * bulk-fetch actuals per distinct domainType, filter to managed domainIds
 * (the managed-guard — unmanaged domainIds are never surfaced or touched),
 * and diff. Mirrors `src/engine/build.ts`'s fetch-error handling.
 */
import type { CtClient } from "../api/ctClient.js";
import { CtApiError } from "../api/ctClient.js";
import type { State } from "../state/state.js";
import type { DesiredResource } from "../engine/types.js";
import { resolveAuthId, CATALOG_META, KNOWN_AUTH_IDS } from "./catalog.js";
import { compareVersions } from "../api/version.js";
import { resolveScope } from "./scope.js";
import { normalizeActual, diffGrants, type GrantTuple, type GrantDiff, type DomainType, type RawPermission } from "./grants.js";
import type { DesiredPermission } from "./types.js";
import { Resolver } from "../resolve/resolver.js";
import { isPendingRef } from "../resolve/refs.js";

export interface PermissionPlanItem { key: string; domainType: DomainType; domainId: number; diff: GrantDiff }

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
): GrantTuple[] {
  return p.grants.flatMap((g): GrantTuple[] => {
    const name = typeof g === "string" ? g : g.right;
    const entry = resolveAuthId(name);
    if (p.domainType === "group_type_role" && entry.authId >= 10000) {
      throw new Error(`${p.domainType} "${p.key}": "${name}" (authId ${entry.authId}) is not writable — ${p.domainType} requires authId < 10000.`);
    }
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
      throw new Error(`${p.domainType} "${p.key}": "${name}" is not a scoped right (no scopeField) — remove "scope" or use a scoped right.`);
    }
    // Retain the symbolic scopeKey on every scoped tuple so its dataId is re-resolved against
    // post-execute state at apply time. `id === null` means the group is declared but not yet
    // created (pending); it renders in the plan and always diffs into toPut (#29, #33.3). A `numeric`
    // resolution (#49 escape hatch) carries no state-backed key to re-resolve — its dataId is already
    // final, so no scopeKey is retained (apply.ts's `reresolveTuple` passes such a tuple through as-is).
    return resolveScope(g.scope, state, declaredGroupKeys).map(({ key, id, numeric }) =>
      id === null
        ? { authId: entry.authId, dataId: [], type: "grant" as const, scopeKey: key, pending: true }
        : numeric
          ? { authId: entry.authId, dataId: [id], type: "grant" as const }
          : { authId: entry.authId, dataId: [id], type: "grant" as const, scopeKey: key },
    );
  });
}

/** A permission whose domainId has been resolved from a logical Ref to a concrete numeric id. */
type ResolvedPermission = DesiredPermission & { domainId: number };

/**
 * Resolve every permission's domainId to a number (#20). A numeric domainId passes straight through;
 * a Ref (e.g. `groupType: "…"`) resolves against the live catalog. A domainId that resolves to a
 * same-run-created resource (PendingRef) is rejected — the permission plan needs a concrete id to
 * fetch actuals and build the write path, and the permission subsystem does not defer that. A
 * group_role ref resolves to its concrete (group, role) pairing id in the resolver (#25).
 *
 * After resolution, the authoritative duplicate-target guard runs on the CONCRETE ids: two different
 * refs (or a ref and a number) that collide on one (domainType, domainId) would otherwise each diff
 * against the other's grants and churn forever. Mirrors the eval-time guard in config/context.ts.
 */
async function resolveDomainIds(
  permissions: DesiredPermission[], resolver: Resolver,
): Promise<ResolvedPermission[]> {
  const resolved: ResolvedPermission[] = [];
  for (const p of permissions) {
    if (typeof p.domainId === "number") {
      resolved.push(p as ResolvedPermission);
      continue;
    }
    const site = `${p.domainType} "${p.key}".domainId`;
    const res = await resolver.resolve(p.domainId, site);
    if (isPendingRef(res)) {
      throw new Error(
        `${site}: references a resource created in the same run — apply it first, or use a numeric id.`,
      );
    }
    resolved.push({ ...p, domainId: res });
  }
  const seen = new Map<string, string>();
  for (const p of resolved) {
    const key = `${p.domainType}:${p.domainId}`;
    const prev = seen.get(key);
    if (prev) {
      throw new Error(
        `Duplicate permission target after resolution: ${p.domainType} #${p.domainId} is declared by ` +
          `both "${prev}" and "${p.key}". Merge their grants into one declaration.`,
      );
    }
    seen.set(key, p.key);
  }
  return resolved;
}

export async function buildPermissionPlan(
  client: Pick<CtClient, "get">, state: State, permissions: DesiredPermission[], desired: DesiredResource[] = [],
  resolver?: Resolver, instanceVersion?: string,
): Promise<{ items: PermissionPlanItem[]; fetchErrors: string[]; warnings: string[] }> {
  const items: PermissionPlanItem[] = [];
  const fetchErrors: string[] = [];
  const warnings: string[] = [];
  // Catalog staleness (#25): the catalog is a snapshot captured against one CT version. If the live
  // instance reports a different version, right names/authIds/scopeFields may have drifted — warn
  // (never fail) so the diff is trusted-but-verified and the fix (regenerate) is one command away.
  if (permissions.length > 0 && instanceVersion && CATALOG_META && compareVersions(instanceVersion, CATALOG_META.ctVersion) !== 0) {
    warnings.push(
      `Permission catalog was captured from ChurchTools ${CATALOG_META.ctVersion} but this instance ` +
        `runs ${instanceVersion}. Right names/authIds may be stale — regenerate it with ` +
        `\`npm run regenerate:permission-catalog\` (see docs/permissions.md).`,
    );
  }
  // Resolve logical domainIds (#20) up front. Shares the command layer's resolver so master-data
  // catalogs are fetched once across buildPlan + buildPermissionPlan; falls back to a private one.
  const resolved = await resolveDomainIds(permissions, resolver ?? new Resolver({ client, state, desired }));
  // Keys declared as groups in the config — valid scope targets even before they are created.
  const declaredGroupKeys = new Set(desired.filter((r) => r.type === "group").map((r) => r.key));
  // one bulk fetch per distinct domainType
  const byType = new Map<DomainType, RawPermission[] | null>();
  for (const dt of new Set(resolved.map((p) => p.domainType))) {
    try {
      byType.set(dt, await client.get<RawPermission[]>(`/permissions/${dt}`));
    } catch (err) {
      const message = err instanceof CtApiError ? `${err.status}` : (err as Error).message;
      fetchErrors.push(`permissions ${dt}: ${message}`);
      byType.set(dt, null);
    }
  }
  for (const p of resolved) {
    const all = byType.get(p.domainType);
    if (all == null) continue; // fetch failed for this domainType — recorded above
    const normalized = normalizeActual(all.filter((r) => r.domainId === p.domainId));
    // Unknown-authId guard (#25): a live GRANT whose authId is absent from the catalog cannot be
    // named or described. Keep it OUT of the diff — otherwise, having no desired counterpart, it
    // would land in `toDelete` and `ct apply` would silently revoke a right we cannot even name.
    // Instead, warn (naming authId + domain) and leave it untouched. Idempotent: excluded every run.
    // (Revoke/deny rows with an unknown authId are already `preserved` by diffGrants, so ignore them
    // here — only unknown grant rows are the churn/silent-revoke hazard.)
    const knownActual: GrantTuple[] = [];
    const unknownAuthIds = new Set<number>();
    for (const t of normalized) {
      if (t.type === "grant" && !KNOWN_AUTH_IDS.has(t.authId)) {
        unknownAuthIds.add(t.authId);
        continue;
      }
      knownActual.push(t);
    }
    for (const authId of [...unknownAuthIds].sort((a, b) => a - b)) {
      warnings.push(
        `${p.domainType} #${p.domainId} ("${p.key}"): a live grant carries authId ${authId}, which is ` +
          `not in the permission catalog — left untouched (never revoked). Regenerate the catalog ` +
          `(\`npm run regenerate:permission-catalog\`) if this right should be manageable.`,
      );
    }
    items.push({ key: p.key, domainType: p.domainType, domainId: p.domainId, diff: diffGrants(desiredTuples(p, state, declaredGroupKeys), knownActual) });
  }
  return { items, fetchErrors, warnings };
}
