import type { State } from "../state/state.js";

/** Resolve scope logical keys to sorted group dataIds. MVP: scope keys must be managed groups. */
export function resolveScope(scopeKeys: string[], state: State): number[] {
  const ids: number[] = [];
  for (const key of scopeKeys) {
    const m = state.resources[key];
    if (!m || m.type !== "group") {
      throw new Error(`Scope key "${key}" does not resolve to a managed group. Declare/adopt it, or use a group already under management.`);
    }
    ids.push(m.id);
  }
  return ids.sort((a, b) => a - b);
}
