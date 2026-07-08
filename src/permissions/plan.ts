/**
 * The permission plan: resolve desired grants to (authId, dataId) tuples,
 * bulk-fetch actuals per distinct domainType, filter to managed domainIds
 * (the managed-guard — unmanaged domainIds are never surfaced or touched),
 * and diff. Mirrors `src/engine/build.ts`'s fetch-error handling.
 */
import type { CtClient } from "../api/ctClient.js";
import { CtApiError } from "../api/ctClient.js";
import type { State } from "../state/state.js";
import { resolveAuthId } from "./catalog.js";
import { resolveScope } from "./scope.js";
import { normalizeActual, diffGrants, type GrantTuple, type GrantDiff, type DomainType, type RawPermission } from "./grants.js";
import type { DesiredPermission } from "./types.js";

export interface PermissionPlanItem { key: string; domainType: DomainType; domainId: number; diff: GrantDiff }

/**
 * Fan out each grant to (authId, dataId) tuples. ChurchTools reads a scoped grant back as
 * ONE ROW PER dataId with a scalar `dataId` (see `normalizeActual`), so a desired tuple with
 * `dataId.length >= 2` can never equal any actual tuple and would churn forever. To match the
 * scalar read shape, a scoped grant `{right, scope:[a,b]}` becomes TWO single-dataId tuples,
 * not one two-element tuple.
 */
export function desiredTuples(p: DesiredPermission, state: State): GrantTuple[] {
  return p.grants.flatMap((g) => {
    const name = typeof g === "string" ? g : g.right;
    const entry = resolveAuthId(name);
    if (p.domainType === "group_type_role" && entry.authId >= 10000) {
      throw new Error(`${p.domainType} "${p.key}": "${name}" (authId ${entry.authId}) is not writable — ${p.domainType} requires authId < 10000.`);
    }
    if (typeof g === "string") return [{ authId: entry.authId, dataId: [], type: "grant" as const }];
    if (entry.scopeField == null) {
      throw new Error(`${p.domainType} "${p.key}": "${name}" is not a scoped right (no scopeField) — remove "scope" or use a scoped right.`);
    }
    return resolveScope(g.scope, state).map((id) => ({ authId: entry.authId, dataId: [id], type: "grant" as const }));
  });
}

export async function buildPermissionPlan(
  client: Pick<CtClient, "get">, state: State, permissions: DesiredPermission[],
): Promise<{ items: PermissionPlanItem[]; fetchErrors: string[] }> {
  const items: PermissionPlanItem[] = [];
  const fetchErrors: string[] = [];
  // one bulk fetch per distinct domainType
  const byType = new Map<DomainType, RawPermission[] | null>();
  for (const dt of new Set(permissions.map((p) => p.domainType))) {
    try {
      byType.set(dt, await client.get<RawPermission[]>(`/permissions/${dt}`));
    } catch (err) {
      const message = err instanceof CtApiError ? `${err.status}` : (err as Error).message;
      fetchErrors.push(`permissions ${dt}: ${message}`);
      byType.set(dt, null);
    }
  }
  for (const p of permissions) {
    const all = byType.get(p.domainType);
    if (all == null) continue; // fetch failed for this domainType — recorded above
    const actual = normalizeActual(all.filter((r) => r.domainId === p.domainId));
    items.push({ key: p.key, domainType: p.domainType, domainId: p.domainId, diff: diffGrants(desiredTuples(p, state), actual) });
  }
  return { items, fetchErrors };
}
