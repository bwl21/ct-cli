import type { State } from "../state/state.js";
import type { GrantTuple } from "./grants.js";

/**
 * One resolved scope entry: `id` is the concrete ChurchTools dataId, or `null` when it names a
 * group declared in the config but not yet created (pending). `numeric` marks an entry that came
 * from a raw numeric scope literal (the #49 escape hatch) rather than a logical group key — such an
 * entry carries no state-backed identity to re-resolve, only its already-known id (see
 * {@link reresolveTuple}, which passes a tuple through unchanged when it has no `scopeKey`).
 */
export interface ScopeResolution { key: string; id: number | null; numeric?: boolean }

/**
 * Resolve a scope array against DESIRED ∪ STATE. Each entry is either:
 *
 * - a **logical group key** (`string`) — resolved against managed groups, exactly as before, or
 * - a **raw numeric dataId** (`number`, #49) — an escape hatch that passes straight through with no
 *   state lookup at all. This is required for scoped rights whose `scopeField` is NOT the group
 *   dimension (`cdb_gruppe`) — e.g. `cc_securitylevel`, `cdb_comment_viewer` — where the dataId
 *   names something this tool has no managed representation for (a security level, not a group),
 *   so a logical key can never be offered for it.
 *
 * A logical key that names a managed group in state resolves to its id. A logical key that names a
 * group DECLARED in this config but not yet in state (`declaredGroupKeys`) resolves to `null`
 * (pending) — its id is only known after the resource tier applies, so it is re-resolved at apply
 * time (see {@link reresolveTuple}). This is what lets a config declare a group AND a grant scoped
 * to it and still plan/apply in one run (#29). A logical key that is neither in state nor declared
 * stays a hard error.
 *
 * Resolved (in-state or numeric) entries sort ascending by id — ChurchTools reads scoped grants
 * back one row per dataId, so a stable order keeps multi-scope grants idempotent. Pending keys
 * follow, sorted by key.
 */
export function resolveScope(
  scopeKeys: (string | number)[],
  state: State,
  declaredGroupKeys: ReadonlySet<string> = new Set(),
): ScopeResolution[] {
  const resolved: ScopeResolution[] = [];
  const pending: ScopeResolution[] = [];
  for (const key of scopeKeys) {
    if (typeof key === "number") {
      if (!Number.isInteger(key) || key <= 0) {
        throw new Error(`Invalid numeric scope entry ${JSON.stringify(key)} — a numeric scope must be a positive integer dataId.`);
      }
      resolved.push({ key: String(key), id: key, numeric: true });
      continue;
    }
    const m = state.resources[key];
    if (m && m.type === "group") {
      resolved.push({ key, id: m.id });
    } else if (declaredGroupKeys.has(key)) {
      pending.push({ key, id: null });
    } else {
      throw new Error(
        `Scope key "${key}" does not resolve to a managed group. Declare/adopt it, use a group already under management, or pass a raw numeric dataId if this right's scope is not a group (see the catalog's scopeField).`,
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
