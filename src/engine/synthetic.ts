/**
 * Generic seam for "synthetic sub-resource fields": pseudo-fields that are not
 * real API columns on a resource (like `parents`), but are folded into the diff
 * on both sides and routed at apply time to a dedicated endpoint. `parents` is
 * the first entry; dynamic groups (and later permission grants) join the same
 * registry so `build.ts`/`execute.ts` never grow per-feature branches.
 */
import type { CtClient } from "../api/ctClient.js";
import type { State } from "../state/state.js";
import type { DesiredResource, FieldChange } from "./types.js";
import { applyHierarchy, parentIdsByGroupId, type HierarchyEntry } from "./hierarchy.js";
import { assertNotPeople } from "./guard.js";

export interface SyntheticFoldCtx {
  client: Pick<CtClient, "get">;
  state: State;
  desired: DesiredResource[];
  actual: Map<string, Record<string, unknown>>;
}
export interface SyntheticApplyCtx {
  client: Pick<CtClient, "request">;
  state: State;
  id: number;
  change: FieldChange;
}
export interface SyntheticField {
  field: string;
  fold(ctx: SyntheticFoldCtx): Promise<{ desired: DesiredResource[]; errors: string[] }>;
  apply(ctx: SyntheticApplyCtx): Promise<void>;
}

function resolveId(state: State, key: string): number {
  const managed = state.resources[key];
  if (!managed) throw new Error(`Cannot resolve parent "${key}" — not under management yet.`);
  return managed.id;
}

/** `parents`: many-to-many group hierarchy, reconciled per-edge. Wraps the existing hierarchy helpers. */
const parentsField: SyntheticField = {
  field: "parents",
  async fold({ client, state, desired, actual }) {
    const hasManagedGroups = Object.values(state.resources).some((m) => m.type === "group");
    if (!hasManagedGroups) return { desired, errors: [] };
    try {
      const raw = await client.get<HierarchyEntry[]>("/groups/hierarchies");
      const parentIds = parentIdsByGroupId(Array.isArray(raw) ? raw : []);
      return { desired: applyHierarchy(desired, state, actual, parentIds), errors: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Leave `parents` undiffed rather than fabricate "add all parents" from an empty map.
      return { desired, errors: [`group hierarchies: ${message}`] };
    }
  },
  async apply({ client, state, id, change }) {
    const from = new Set(Array.isArray(change.from) ? (change.from as string[]) : []);
    const to = new Set(Array.isArray(change.to) ? (change.to as string[]) : []);
    for (const key of [...to].filter((k) => !from.has(k))) {
      const path = `/groups/${id}/parents/${resolveId(state, key)}`;
      assertNotPeople(path);
      await client.request("PUT", path);
    }
    for (const key of [...from].filter((k) => !to.has(k))) {
      const path = `/groups/${id}/parents/${resolveId(state, key)}`;
      assertNotPeople(path);
      await client.request("DELETE", path);
    }
  },
};

export const SYNTHETIC_FIELDS: SyntheticField[] = [parentsField];

const BY_FIELD = new Map(SYNTHETIC_FIELDS.map((f) => [f.field, f]));
export function isSyntheticField(field: string): boolean {
  return BY_FIELD.has(field);
}
export function syntheticField(field: string): SyntheticField | undefined {
  return BY_FIELD.get(field);
}

/** Run every registered fold in order, threading the (immutably) augmented desired through each. */
export async function foldSynthetic(
  ctx: SyntheticFoldCtx,
): Promise<{ desired: DesiredResource[]; errors: string[] }> {
  let desired = ctx.desired;
  const errors: string[] = [];
  for (const f of SYNTHETIC_FIELDS) {
    const res = await f.fold({ ...ctx, desired });
    desired = res.desired;
    errors.push(...res.errors);
  }
  return { desired, errors };
}
