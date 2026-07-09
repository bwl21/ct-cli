/**
 * The diff engine: compare desired state (config) against the state file and
 * the actual ChurchTools values, and produce an ordered plan.
 *
 * Managed-guard: only resources in config or the state file are ever
 * considered. Anything else in ChurchTools is invisible — never diffed, never
 * proposed for deletion.
 *
 * `actual` is keyed by **logical key**, not CT id: ids are only unique within a
 * type (the Mainz campus is id 0), so a numeric-id map would collide across
 * types. Logical keys are globally unique in the state file.
 */
import type { State } from "../state/state.js";
import type { DesiredResource, FieldChange, Plan, PlanItem } from "./types.js";
import { orderKeys, isKnownType } from "./graph.js";

/**
 * Structural deep-equal. Order-independent for objects, so a mere key-order
 * difference between the API's JSON and the config's object is NOT reported as a
 * change (a `JSON.stringify` comparison would flag it, proposing an update that
 * can never converge).
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

/** Field-by-field diff over the first arg's fields only. `diffFields(fields, {})` yields a full creation change set. */
export function diffFields(desired: Record<string, unknown>, actual: Record<string, unknown>): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [field, to] of Object.entries(desired)) {
    if (!deepEqual(actual[field], to)) {
      changes.push({ field, from: actual[field], to });
    }
  }
  return changes;
}

/** Drift over the managed fields: what changed in ChurchTools since the snapshot (last known → actual). */
export function driftFields(
  lastKnown: Record<string, unknown>,
  actual: Record<string, unknown>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [field, known] of Object.entries(lastKnown)) {
    if (!deepEqual(actual[field], known)) {
      changes.push({ field, from: known, to: actual[field] });
    }
  }
  return changes;
}

export interface ComputePlanOptions {
  /** Logical keys whose managed type has no registry entry — cannot be fetched, so left untouched (not recreated/deleted). */
  unresolved?: ReadonlySet<string>;
  /**
   * Logical keys whose actual value could not be fetched (a non-404 error). Mapped
   * to a short status descriptor (e.g. "500"). These are NOT vanished resources, so
   * they must be excluded from create/recreate/stale classification and surfaced as
   * a fetch failure — otherwise a transient 500 reads as "recreate — missing in CT".
   */
  fetchFailed?: ReadonlyMap<string, string>;
}

export function computePlan(
  desired: DesiredResource[],
  state: State,
  actual: Map<string, Record<string, unknown>>,
  opts: ComputePlanOptions = {},
): Plan {
  const unresolved = opts.unresolved ?? new Set<string>();
  const fetchFailed = opts.fetchFailed ?? new Map<string, string>();

  for (const d of desired) {
    if (!isKnownType(d.type)) {
      throw new Error(
        `Unknown resource type "${d.type}" for "${d.key}" — no apply tier defined. Add it to TYPE_TIER.`,
      );
    }
  }

  const desiredByKey = new Map(desired.map((d) => [d.key, d]));
  const creates: PlanItem[] = [];
  const updates: PlanItem[] = [];
  const deletes: PlanItem[] = [];

  for (const d of desired) {
    const managed = state.resources[d.key];
    if (!managed) {
      creates.push({
        type: d.type,
        key: d.key,
        id: null,
        action: "create",
        changes: diffFields(d.fields, {}),
      });
      continue;
    }
    if (managed.type !== d.type) {
      throw new Error(
        `Logical key "${d.key}" is a ${d.type} in the config but a ${managed.type} in the state file. ` +
          `Rename one to reconcile.`,
      );
    }
    if (unresolved.has(d.key)) {
      // Type has no registry entry — we could not fetch its actual value, so we cannot diff it.
      updates.push({
        type: d.type,
        key: d.key,
        id: managed.id,
        action: "no-op",
        changes: [],
        note: "unresolved-type",
      });
      continue;
    }
    if (fetchFailed.has(d.key)) {
      // Fetch errored (non-404). We can't diff it, and it is NOT gone — do not propose a recreate.
      updates.push({
        type: d.type,
        key: d.key,
        id: managed.id,
        action: "no-op",
        changes: [],
        note: "fetch-failed",
        detail: fetchFailed.get(d.key),
      });
      continue;
    }
    const a = actual.get(d.key);
    if (!a) {
      creates.push({
        type: d.type,
        key: d.key,
        id: null,
        action: "create",
        changes: diffFields(d.fields, {}),
        note: "recreate",
      });
      continue;
    }
    const changes = diffFields(d.fields, a);
    const drift = driftFields(managed.fields, a);
    updates.push({
      type: d.type,
      key: d.key,
      id: managed.id,
      action: changes.length > 0 ? "update" : "no-op",
      changes,
      // The fetched actual — the write body is built from this, not the stale state snapshot (#27).
      actual: a,
      drift: drift.length > 0 ? drift : undefined,
    });
  }

  for (const managed of Object.values(state.resources)) {
    if (desiredByKey.has(managed.key)) {
      continue;
    }
    if (unresolved.has(managed.key)) {
      deletes.push({
        type: managed.type,
        key: managed.key,
        id: managed.id,
        action: "no-op",
        changes: [],
        note: "unresolved-type",
      });
      continue;
    }
    if (fetchFailed.has(managed.key)) {
      // Fetch errored — we can't tell if it is gone, so do not propose a stale-prune.
      deletes.push({
        type: managed.type,
        key: managed.key,
        id: managed.id,
        action: "no-op",
        changes: [],
        note: "fetch-failed",
        detail: fetchFailed.get(managed.key),
      });
      continue;
    }
    const a = actual.get(managed.key);
    if (!a) {
      // Already gone from ChurchTools but still in the state file — surface it so the user prunes state (not a silent no-op).
      deletes.push({
        type: managed.type,
        key: managed.key,
        id: managed.id,
        action: "no-op",
        changes: [],
        note: "stale",
      });
      continue;
    }
    deletes.push({ type: managed.type, key: managed.key, id: managed.id, action: "delete", changes: [] });
  }

  const rank = new Map(orderKeys(desired).map((key, i) => [key, i]));
  const ordered = [...creates, ...updates].sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));

  // Deletes run in reverse dependency order. Reuse the same topological sort (reversed) rather than a
  // coarser tier-only heuristic, so intra-tier edges are honoured once the state file carries them.
  const deleteRank = new Map(
    orderKeys(deletes.map((it) => ({ type: it.type, key: it.key, fields: {}, dependsOn: [] }))).map(
      (key, i) => [key, i],
    ),
  );
  deletes.sort((a, b) => (deleteRank.get(b.key) ?? 0) - (deleteRank.get(a.key) ?? 0));

  return { items: [...ordered, ...deletes] };
}
