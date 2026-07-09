/**
 * Generic seam for "synthetic sub-resource fields": pseudo-fields that are not
 * real API columns on a resource (like `parents`), but are folded into the diff
 * on both sides and routed at apply time to a dedicated endpoint. `parents` is
 * the first entry; dynamic groups (and later permission grants) join the same
 * registry so `build.ts`/`execute.ts` never grow per-feature branches.
 */
import type { CtClient } from "../api/ctClient.js";
import { CtApiError } from "../api/ctClient.js";
import type { State } from "../state/state.js";
import type { DesiredResource, FieldChange } from "./types.js";
import { applyHierarchy, parentIdsByGroupId, type HierarchyEntry } from "./hierarchy.js";
import { assertNotPeople } from "./guard.js";
import { warn } from "../ui.js";
import { normalizeDynamic, normalizeRuleset, resolveRulesetRef } from "./dynamic.js";
import type { DynamicStatus } from "./types.js";

export interface SyntheticFoldCtx {
  client: Pick<CtClient, "get">;
  state: State;
  desired: DesiredResource[];
  actual: Map<string, Record<string, unknown>>;
  /** Directory of the config file, so `{ ref }` ruleset paths resolve relative to it (not the cwd). */
  configDir?: string;
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
      warn(`Failed to fetch group hierarchies: ${message}`);
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

/** `dynamic`: dynamic-group ruleset + status, reconciled as one synthetic field. */
const dynamicField: SyntheticField = {
  field: "dynamic",
  async fold({ client, state, desired, actual, configDir }) {
    const optedIn = new Set(desired.filter((d) => d.type === "group" && d.dynamic !== undefined).map((d) => d.key));
    if (optedIn.size === 0) return { desired, errors: [] };
    const errors: string[] = [];
    for (const managed of Object.values(state.resources)) {
      if (managed.type !== "group" || !optedIn.has(managed.key)) continue;
      const a = actual.get(managed.key);
      if (!a) continue; // vanished from CT → handled as a recreate by the plain plan
      // The ruleset GET and the status GET have distinct failure meanings, so they get distinct
      // try/catch blocks: only a ruleset 404 means "not a dynamic group". A status GET that fails
      // AFTER a successful ruleset GET must NOT fabricate the "none" sentinel (that would discard a
      // real ruleset and propose a spurious re-PUT) — it degrades the plan via `errors` instead.
      let ruleset: Record<string, unknown>;
      try {
        ruleset = await client.get<Record<string, unknown>>(`/dynamicgroups/${managed.id}/ruleset`);
      } catch (err) {
        if (err instanceof CtApiError && err.status === 404) {
          // Group exists but is not (yet) a dynamic group — its ruleset 404s. Sentinel so a promote
          // (desired active vs actual none) diffs as a real change and demote-to-none is a clean no-op.
          a.dynamic = { status: "none", ruleset: {} };
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`dynamic ${managed.key} (#${managed.id}): ${message}`);
        continue;
      }
      try {
        const statusRes = await client.get<{ dynamicGroupStatus?: string }>(`/dynamicgroups/${managed.id}/status`);
        a.dynamic = {
          status: (statusRes?.dynamicGroupStatus ?? "none") as DynamicStatus,
          ruleset: normalizeRuleset(ruleset),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`dynamic ${managed.key} status (#${managed.id}): ${message}`);
      }
    }
    const augmented = desired.map((d) =>
      d.type === "group" && d.dynamic !== undefined
        ? { ...d, fields: { ...d.fields, dynamic: normalizeDynamic({ status: d.dynamic.status, ruleset: resolveRulesetRef(d.dynamic.ruleset, configDir, d.key) }) } }
        : d,
    );
    return { desired: augmented, errors };
  },
  async apply({ client, id, change }) {
    const to = change.to as { status: DynamicStatus; ruleset: Record<string, unknown> } | undefined;
    if (!to || to.status === "none") {
      assertNotPeople(`/dynamicgroups/${id}/ruleset`);
      await client.request("DELETE", `/dynamicgroups/${id}/ruleset`);
      assertNotPeople(`/dynamicgroups/${id}/status`);
      await client.request("PUT", `/dynamicgroups/${id}/status`, { dynamicGroupStatus: "none" });
      return;
    }
    assertNotPeople(`/dynamicgroups/${id}/ruleset`);
    await client.request("PUT", `/dynamicgroups/${id}/ruleset`, { dynamicGroupRuleSet: to.ruleset });
    assertNotPeople(`/dynamicgroups/${id}/status`);
    await client.request("PUT", `/dynamicgroups/${id}/status`, { dynamicGroupStatus: to.status });
  },
};

export const SYNTHETIC_FIELDS: SyntheticField[] = [parentsField, dynamicField];

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
