/**
 * Shared engine types: the desired-state resources parsed from config, and the
 * plan produced by diffing desired vs state vs actual.
 */

export type DynamicStatus = "active" | "inactive" | "manual" | "none";

export interface DynamicSpec {
  status: DynamicStatus;
  /** RuleSet object, or a { ref: "./path.json" } reference, or a typed-query build result. */
  ruleset: unknown;
}

export interface DesiredResource {
  type: string;
  key: string;
  /** Managed fields — same shape as the Phase 2 registry snapshot, so they diff like-for-like against actual. */
  fields: Record<string, unknown>;
  /** Ordering hint: a dependency edge only (may point at a campus). NOT managed hierarchy — see `parents`. */
  parent?: string;
  /** Managed parent group keys (hierarchy). `undefined` = hierarchy not managed for this group; `[]` = should have no managed parents. */
  parents?: string[];
  /** Auto-group / dynamic-group config. Opt-in: `undefined` = not a dynamic group. Only valid on a group. */
  dynamic?: DynamicSpec;
  /** Logical keys this resource must be applied after (includes `parent`/`parents`). */
  dependsOn: string[];
  /** Lifecycle flag: block `ct destroy` for this resource. Never diffed or sent to the API. */
  preventDestroy?: boolean;
}

export type PlanAction = "create" | "update" | "delete" | "no-op";

/**
 * A resource that needs surfacing beyond its plain action:
 *  - `recreate`         — desired + managed, but vanished from ChurchTools (a create that replaces a dead id).
 *  - `stale`            — managed + dropped from config + already gone from ChurchTools (nothing to delete; prune from state).
 *  - `unresolved-type`  — managed but its type has no registry entry, so it cannot be fetched/diffed (left untouched).
 *  - `fetch-failed`     — managed but its actual value could not be fetched (non-404 error); NOT a vanish, so it is
 *                         excluded from create/recreate/stale classification and rendered as a fetch failure.
 */
export type PlanNote = "recreate" | "stale" | "unresolved-type" | "fetch-failed";

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface PlanItem {
  type: string;
  key: string;
  /** CT id when known (updates/deletes); null for creates. */
  id: number | null;
  action: PlanAction;
  /** For create: every desired field; update: only the differences; delete/no-op: empty. */
  changes: FieldChange[];
  /**
   * The fetched actual managed fields (updates only). The write body is built from
   * THIS, not the stale state snapshot — so a field that drifted in the CT UI but
   * isn't in `changes` passes through untouched instead of being reverted (#27).
   */
  actual?: Record<string, unknown>;
  /** Manual changes in ChurchTools since adoption (last-known snapshot vs actual). */
  drift?: FieldChange[];
  /** A non-standard state the plan must surface (see {@link PlanNote}). */
  note?: PlanNote;
  /** Extra human-readable context for a note (e.g. the HTTP status behind `fetch-failed`). */
  detail?: string;
  /**
   * The config's `preventDestroy` for this desired resource, carried so apply can
   * mirror it onto the state entry (state, not config, guards `destroy`). Only set
   * on desired-side items; undefined on delete-side items.
   */
  preventDestroy?: boolean;
}

export interface Plan {
  /** Items in execution order: creates/updates in dependency order, deletes in reverse. */
  items: PlanItem[];
}

export function summarize(plan: Plan): Record<PlanAction, number> {
  const counts: Record<PlanAction, number> = { create: 0, update: 0, delete: 0, "no-op": 0 };
  for (const item of plan.items) {
    counts[item.action]++;
  }
  return counts;
}
