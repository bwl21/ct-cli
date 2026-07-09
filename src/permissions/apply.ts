/**
 * Apply a permission plan: PUT each new grant, DELETE each removed tuple.
 * Idempotent — re-running against an unchanged instance diffs to empty and
 * this issues no requests. Every path is guarded through `assertNotPeople`
 * as belt-and-suspenders atop the structural-only registry.
 */
import type { CtClient } from "../api/ctClient.js";
import type { State } from "../state/state.js";
import { assertNotPeople } from "../engine/guard.js";
import type { PermissionPlanItem } from "./plan.js";
import type { GrantTuple } from "./grants.js";
import { reresolveTuple } from "./scope.js";

function body(t: GrantTuple): Record<string, unknown> {
  if (t.pending) {
    // A pending tuple's dataId is unknown until it is re-resolved against post-execute state.
    // Reaching here means re-resolution was skipped — refuse rather than emit a silent GLOBAL grant.
    throw new Error(`Grant scoped to "${t.scopeKey}" was not re-resolved before apply — refusing to write it without a dataId.`);
  }
  const b: Record<string, unknown> = { authId: t.authId, type: t.type };
  if (t.dataId.length) b.dataId = t.dataId; // omit when unscoped
  return b;
}

/**
 * Apply a permission plan. When `state` is provided, each scoped grant's dataId is RE-RESOLVED
 * against it just before the PUT — `state` here is the POST-execute state (executePlan has upserted
 * every created/recreated group), so grants are always written with fresh ids and a group created in
 * the same apply gets its real id (#29, #33.3). Without `state`, tuples are written as-is.
 */
export async function applyPermissionPlan(
  items: PermissionPlanItem[],
  client: Pick<CtClient, "request">,
  state?: State,
): Promise<{ granted: number; deleted: number }> {
  let granted = 0;
  let deleted = 0;
  for (const item of items) {
    const path = `/permissions/${item.domainType}/${item.domainId}`;
    assertNotPeople(path);
    for (const t of item.diff.toPut) {
      await client.request("PUT", path, body(state ? reresolveTuple(t, state) : t));
      granted++;
    }
    for (const t of item.diff.toDelete) {
      await client.request("DELETE", path, body(t));
      deleted++;
    }
  }
  return { granted, deleted };
}
