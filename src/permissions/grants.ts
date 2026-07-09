/**
 * Grant tuples and set reconciliation. A grant's identity is (authId, sorted dataId, type).
 * Actuals exclude the self-re-adding system baseline (modifiedPid === -1) and inherited rows,
 * so reconciliation owns only user-authored grants and never fights the platform.
 */
export type DomainType = "group_role" | "group_type_role";

export interface GrantTuple {
  authId: number;
  dataId: number[];
  type: "grant" | "revoke";
  /**
   * For a scoped grant: the symbolic scope key this tuple was resolved from. Retained so the
   * dataId can be RE-RESOLVED against post-execute state at apply time — which fixes both a grant
   * scoped to a group created in the same apply (its dataId is `pending` at plan time) and a stale
   * dataId after a scope-target group is recreated (#29, #33.3). Absent on unscoped grants and on
   * actual tuples read back from ChurchTools.
   */
  scopeKey?: string;
  /**
   * True when `scopeKey` names a group DECLARED in this config but not yet created (absent from
   * state at plan time). Its real dataId is unknown until `executePlan` runs, so the plan renders
   * it as pending and it always diffs into `toPut`. Cleared once re-resolved at apply time.
   */
  pending?: boolean;
}
export interface RawPermission {
  authId: number; dataId: number | null; type: "grant" | "revoke"; domainId: number;
  isInherited?: boolean; meta?: { modifiedPid?: number };
}

/**
 * Identity key for set reconciliation. A pending tuple has no resolved dataId yet, so key it by
 * its symbolic scope key instead — that keeps it distinct from an unscoped grant (`dataId: []`)
 * and guarantees it can never collide with an actual row (actuals never carry a scopeKey), so it
 * always lands in `toPut`.
 */
export function tupleKey(t: { authId: number; dataId: number[]; type: string; scopeKey?: string; pending?: boolean }): string {
  const scope = t.pending && t.scopeKey != null ? `pending:${t.scopeKey}` : [...t.dataId].sort((a, b) => a - b).join(",");
  return `${t.type}:${t.authId}:${scope}`;
}

export function normalizeActual(rows: RawPermission[]): GrantTuple[] {
  const out: GrantTuple[] = [];
  for (const r of rows) {
    if (r.meta?.modifiedPid === -1) continue; // system baseline — invisible to reconciliation
    if (r.isInherited) continue;              // inherited — not directly owned here
    const dataId = r.dataId == null ? [] : [r.dataId];
    out.push({ authId: r.authId, dataId: dataId.sort((a, b) => a - b), type: r.type });
  }
  return out;
}

export interface GrantDiff { toPut: GrantTuple[]; toDelete: GrantTuple[]; preserved: GrantTuple[] }

export function diffGrants(desired: GrantTuple[], actual: GrantTuple[]): GrantDiff {
  // Reconciliation owns only user-authored GRANT rows. `desiredTuples` only ever emits
  // `type: "grant"`, so an explicit deny row (`type: "revoke"`) has no desired counterpart and
  // would land in `toDelete` — silently removing an admin's deny. Treat non-grant rows as
  // unmanaged: keep them out of the diff and surface them as an informational `preserved` note.
  const managedActual = actual.filter((t) => t.type === "grant");
  const preserved = actual.filter((t) => t.type !== "grant");
  const desiredKeys = new Map(desired.map((t) => [tupleKey(t), t]));
  const actualKeys = new Map(managedActual.map((t) => [tupleKey(t), t]));
  const toPut = [...desiredKeys].filter(([k]) => !actualKeys.has(k)).map(([, t]) => t);
  const toDelete = [...actualKeys].filter(([k]) => !desiredKeys.has(k)).map(([, t]) => t);
  return { toPut, toDelete, preserved };
}
