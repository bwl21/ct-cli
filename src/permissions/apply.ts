/**
 * Apply a permission plan: PUT each new grant, DELETE each removed tuple.
 * Idempotent — re-running against an unchanged instance diffs to empty and
 * this issues no requests. Every path is guarded through `assertNotPeople`
 * as belt-and-suspenders atop the structural-only registry.
 */
import type { CtClient } from "../api/ctClient.js";
import { assertNotPeople } from "../engine/guard.js";
import type { PermissionPlanItem } from "./plan.js";
import type { GrantTuple } from "./grants.js";

function body(t: GrantTuple): Record<string, unknown> {
  const b: Record<string, unknown> = { authId: t.authId, type: t.type };
  if (t.dataId.length) b.dataId = t.dataId; // omit when unscoped
  return b;
}

export async function applyPermissionPlan(
  items: PermissionPlanItem[],
  client: Pick<CtClient, "request">,
): Promise<{ granted: number; deleted: number }> {
  let granted = 0;
  let deleted = 0;
  for (const item of items) {
    const path = `/permissions/${item.domainType}/${item.domainId}`;
    assertNotPeople(path);
    for (const t of item.diff.toPut) {
      await client.request("PUT", path, body(t));
      granted++;
    }
    for (const t of item.diff.toDelete) {
      await client.request("DELETE", path, body(t));
      deleted++;
    }
  }
  return { granted, deleted };
}
