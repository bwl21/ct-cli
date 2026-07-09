import type { State } from "../state/state.js";
import type { GrantTuple } from "./grants.js";

/** One resolved scope key: `id` is the state group id, or `null` when the group is declared in the config but not yet created (pending). */
export interface ScopeResolution { key: string; id: number | null }

/**
 * Resolve scope logical keys against DESIRED ∪ STATE.
 *
 * A key that names a managed group in state resolves to its id. A key that names a group DECLARED
 * in this config but not yet in state (`declaredGroupKeys`) resolves to `null` (pending) — its id
 * is only known after the resource tier applies, so it is re-resolved at apply time (see
 * {@link reresolveTuple}). This is what lets a config declare a group AND a grant scoped to it and
 * still plan/apply in one run (#29). A key that is neither in state nor declared stays a hard error.
 *
 * Resolved (in-state) keys sort ascending by id — ChurchTools reads scoped grants back one row per
 * dataId, so a stable order keeps multi-scope grants idempotent. Pending keys follow, sorted by key.
 */
export function resolveScope(
  scopeKeys: string[],
  state: State,
  declaredGroupKeys: ReadonlySet<string> = new Set(),
): ScopeResolution[] {
  const resolved: ScopeResolution[] = [];
  const pending: ScopeResolution[] = [];
  for (const key of scopeKeys) {
    const m = state.resources[key];
    if (m && m.type === "group") {
      resolved.push({ key, id: m.id });
    } else if (declaredGroupKeys.has(key)) {
      pending.push({ key, id: null });
    } else {
      throw new Error(
        `Scope key "${key}" does not resolve to a managed group. Declare/adopt it, or use a group already under management.`,
      );
    }
  }
  resolved.sort((a, b) => (a.id as number) - (b.id as number));
  pending.sort((a, b) => a.key.localeCompare(b.key));
  return [...resolved, ...pending];
}

/**
 * Re-resolve a scoped grant tuple's dataId against the current (post-execute) state, using the
 * symbolic scopeKey retained on the tuple. Fixes stale ids after a recreate and fills in the id of
 * a group created in the same apply. Unscoped tuples (no scopeKey) pass through unchanged. Throws
 * if the scope key no longer resolves to a managed group — which should be impossible once the
 * resource tier has applied, so it signals a real inconsistency rather than being silently skipped.
 */
export function reresolveTuple(t: GrantTuple, state: State): GrantTuple {
  if (t.scopeKey == null) return t;
  const m = state.resources[t.scopeKey];
  if (!m || m.type !== "group") {
    throw new Error(
      `Scope key "${t.scopeKey}" did not resolve to a managed group after apply — cannot write its grant with a valid dataId.`,
    );
  }
  return { ...t, dataId: [m.id], pending: false };
}
