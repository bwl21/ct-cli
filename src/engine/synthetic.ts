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
import type { DesiredResource, FieldChange, Plan, PlanItem } from "./types.js";
import { applyHierarchy, parentIdsByGroupId, type HierarchyEntry } from "./hierarchy.js";
import { assertNotPeople } from "./guard.js";
import { deepEqual } from "./plan.js";
import { mapConcurrent } from "../util/concurrency.js";
import { info, warn, formatError } from "../ui.js";
import { normalizeDynamic, normalizeRuleset, putRulesetBody, resolveRulesetRef } from "./dynamic.js";
import { formatPortablizeWarnings, scanUnportablized } from "../config/query-refs.js";
import type { DynamicStatus } from "./types.js";

/** How many dynamic groups to fetch (ruleset + status) from ChurchTools at once. Mirrors build.ts. */
const DYNAMIC_FETCH_CONCURRENCY = 8;

/** The per-group counts CT returns from POST /dynamicgroups/{id}/refresh. */
interface RefreshResult {
  created: number;
  updated: number;
  deleted: number;
}

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
export interface SyntheticPostApplyCtx {
  client: Pick<CtClient, "request">;
  state: State;
  /** Post-execute id from state (creates already carry their real id). */
  id: number;
  item: PlanItem;
  change: FieldChange;
}
export interface SyntheticField {
  field: string;
  fold(ctx: SyntheticFoldCtx): Promise<{ desired: DesiredResource[]; errors: string[] }>;
  apply(ctx: SyntheticApplyCtx): Promise<void>;
  /**
   * Optional opt-in side effect run AFTER the whole plan has applied (e.g. `ct apply --refresh`
   * materializing dynamic-group membership). Keeps field-specific post-apply knowledge in the
   * field, not the command layer. Must swallow its own errors — one field's failure must not
   * abort the others.
   */
  postApply?(ctx: SyntheticPostApplyCtx): Promise<void>;
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
    // Gate on the DESIRED side, not the pre-apply state: on a fresh state the
    // groups don't exist yet, so a state-side gate returns early and the first
    // apply drops every declared hierarchy edge (flat groups, exit 0). Gating on
    // "some desired group opted into parents" makes the first apply create edges,
    // and still skips the /groups/hierarchies fetch when nobody opts in.
    const optedIn = desired.some((d) => d.type === "group" && d.parents !== undefined);
    if (!optedIn) return { desired, errors: [] };
    try {
      const raw = await client.get<HierarchyEntry[]>("/groups/hierarchies");
      const parentIds = parentIdsByGroupId(Array.isArray(raw) ? raw : []);
      return { desired: applyHierarchy(desired, state, actual, parentIds), errors: [] };
    } catch (err) {
      const message = formatError(err);
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
    // Single pass over the DESIRED opt-ins (mirrors hierarchy's desired-side gate): a group is
    // folded only if it declared `dynamic` AND is under management AND was fetched. Replaces the
    // old build-a-Set-then-invert-over-state pattern (one predicate, not three).
    const targets = desired.flatMap((d) => {
      if (d.type !== "group" || d.dynamic === undefined) return [];
      const managed = state.resources[d.key];
      if (!managed || managed.type !== "group") return []; // not adopted yet → created by the plain plan
      const a = actual.get(d.key);
      if (!a) return []; // vanished from CT → handled as a recreate by the plain plan
      return [{ managed, a }];
    });
    if (targets.length === 0) return { desired, errors: [] };
    // Fetch each group's (ruleset, status) concurrently — 2N serial round-trips otherwise dominate
    // plan/apply latency on a config with many dynamic groups. Within a group the two GETs stay
    // sequential: the status GET must run only after the ruleset GET succeeds (a 404 there means
    // "not a dynamic group" and short-circuits). Per-group error strings are collected in input
    // order so the plan-degradation output is deterministic regardless of completion order.
    const perGroupErrors = await mapConcurrent(targets, DYNAMIC_FETCH_CONCURRENCY, async ({ managed, a }) => {
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
          return [];
        }
        return [`dynamic ${managed.key} (#${managed.id}): ${formatError(err)}`];
      }
      try {
        const statusRes = await client.get<{ dynamicGroupStatus?: string }>(`/dynamicgroups/${managed.id}/status`);
        a.dynamic = {
          status: (statusRes?.dynamicGroupStatus ?? "none") as DynamicStatus,
          ruleset: normalizeRuleset(ruleset),
        };
        return [];
      } catch (err) {
        return [`dynamic ${managed.key} status (#${managed.id}): ${formatError(err)}`];
      }
    });
    const errors = perGroupErrors.flat();
    const augmented = desired.map((d) => {
      if (d.type !== "group" || d.dynamic === undefined) return d;
      // Demote-to-none: fold to the SAME sentinel the actual side uses for a non-dynamic group
      // ({ status: "none", ruleset: {} }). The docs tell users to KEEP the dynamic block when
      // demoting, so their authored ruleset is still present here — but folding it would diff
      // forever against the sentinel actual. Collapsing both sides makes a demoted group converge.
      if (d.dynamic.status === "none") {
        return { ...d, fields: { ...d.fields, dynamic: { status: "none" as DynamicStatus, ruleset: {} } } };
      }
      const resolvedRuleset = resolveRulesetRef(d.dynamic.ruleset, configDir, d.key);
      // Un-portablized ids report at PLAN time too (#101), not only at adoption. A ruleset carrying
      // another host's ids round-trips byte-identically against the host it was written for, so the
      // plan is green and the damage — an auto-group collecting the wrong people — is invisible until
      // someone notices the membership. Warn, never fail: the numeric form stays a valid escape hatch.
      const unportable = scanUnportablized(resolvedRuleset);
      if (unportable.length > 0) {
        warn(
          `dynamic group "${d.key}": ruleset carries ${unportable.length} host-specific id(s) — ` +
            `not portable to another instance:`,
        );
        for (const line of formatPortablizeWarnings(unportable)) info(`    ${line}`);
      }
      const dynamic = normalizeDynamic({ status: d.dynamic.status, ruleset: resolvedRuleset });
      return { ...d, fields: { ...d.fields, dynamic } };
    });
    return { desired: augmented, errors };
  },
  async apply({ client, id, change }) {
    const to = change.to as { status: DynamicStatus; ruleset: Record<string, unknown> } | undefined;
    const from = change.from as { status?: DynamicStatus; ruleset?: Record<string, unknown> } | undefined;
    if (!to || to.status === "none") {
      assertNotPeople(`/dynamicgroups/${id}/ruleset`);
      // A group that was never dynamic (or is already demoted) has no ruleset to delete — CT 404s.
      // Tolerate that: the desired end-state (no ruleset) already holds, so treat it as done.
      try {
        await client.request("DELETE", `/dynamicgroups/${id}/ruleset`);
      } catch (err) {
        if (!(err instanceof CtApiError && err.status === 404)) throw err;
      }
      assertNotPeople(`/dynamicgroups/${id}/status`);
      await client.request("PUT", `/dynamicgroups/${id}/status`, { dynamicGroupStatus: "none" });
      return;
    }
    // A pure status flip (active↔inactive) leaves the ruleset byte-identical — skip the re-PUT so we
    // don't rewrite an unchanged ruleset (wasteful, and may trigger a server-side recalculation). A
    // fresh promote (`from` undefined / previously non-dynamic) has no comparable ruleset, so PUT it.
    const rulesetChanged = from?.ruleset === undefined || !deepEqual(from.ruleset, to.ruleset);
    if (rulesetChanged) {
      assertNotPeople(`/dynamicgroups/${id}/ruleset`);
      await client.request("PUT", `/dynamicgroups/${id}/ruleset`, putRulesetBody(to.ruleset));
    }
    assertNotPeople(`/dynamicgroups/${id}/status`);
    await client.request("PUT", `/dynamicgroups/${id}/status`, { dynamicGroupStatus: to.status });
  },
  async postApply({ client, id, item, change }) {
    // `ct apply --refresh`: materialize computed membership for a changed dynamic group. Per-group
    // only — the all-groups /dynamicgroups/refresh endpoint has a huge blast radius and is never
    // called from here. Owns the demote-sentinel knowledge so the command layer stays field-agnostic.
    const to = change.to as { status?: string } | undefined;
    if (to?.status === "none") return; // demoted to a non-dynamic group — nothing to refresh
    const path = `/dynamicgroups/${id}/refresh`;
    assertNotPeople(path);
    try {
      const res = await client.request<RefreshResult[]>("POST", path);
      const r = res?.[0];
      if (r) info(`refreshed ${item.key}: +${r.created} ~${r.updated} -${r.deleted}`);
    } catch (err) {
      warn(`Failed to refresh ${item.key} (#${id}): ${formatError(err)}`);
    }
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

/**
 * Drive every synthetic field's optional `postApply` hook over an applied plan (e.g. the opt-in
 * `ct apply --refresh` dynamic-group refresh). Runs after `executePlan`, so ids are read from the
 * POST-execute state — a create already carries its real id. Skips no-op/delete items and any item
 * whose key is not (yet) resolvable in state (explicit `undefined` check — CT ids can be `0`). Each
 * hook swallows its own errors, so one field/group failing never blocks the rest.
 */
export async function runPostApplyHooks(
  plan: Plan,
  state: State,
  client: Pick<CtClient, "request">,
): Promise<void> {
  for (const item of plan.items) {
    if (item.action === "no-op" || item.action === "delete") continue;
    for (const change of item.changes) {
      const f = syntheticField(change.field);
      if (!f?.postApply) continue;
      const id = state.resources[item.key]?.id;
      if (id === undefined) continue;
      await f.postApply({ client, state, id, item, change });
    }
  }
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
