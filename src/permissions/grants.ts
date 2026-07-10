/**
 * Grant tuples and set reconciliation. A grant's identity is (authId, sorted dataId, type).
 * Actuals exclude the self-re-adding system baseline (modifiedPid === -1) and inherited rows,
 * so reconciliation owns only user-authored grants and never fights the platform.
 */
export type DomainType = "group_role" | "group_type_role";

/**
 * Smallest authId of the inheritance-only rights family (the `churchdb:+…` rights). These reach
 * roles via inheritance and are NOT writable on a group_type_role domain — CT exposes them as
 * readable rows there, but any write is rejected.
 */
export const INHERITED_RIGHT_MIN_AUTH_ID = 10000;

/**
 * Whether a right is readable-but-not-writable on this domain type: it reaches roles via
 * inheritance only, so it can neither be declared (`desiredTuples` throws for it) nor adopted
 * (adopt emits it as a NOTE comment, never an active grant).
 *
 * SINGLE SOURCE OF TRUTH — this predicate MUST be shared by three sites that would otherwise drift
 * and reopen issue #65:
 *  1. `desiredTuples` (plan.ts) rejects declaring such a right,
 *  2. `emitAdoptedGrants` (adopt.ts) excludes it from the emitted block, and
 *  3. `buildPermissionPlan` (plan.ts) excludes matching LIVE rows from the ACTUAL diff set.
 * If (1)/(2) exclude a right but (3) keeps it, the plan demands a revoke the DSL can never satisfy
 * — pasted adopt output can never converge to a no-op (the #65 bug).
 *
 * Today only group_type_role carries such rights (authId >= 10000).
 */
export function isInheritedOnlyRight(domainType: DomainType, authId: number): boolean {
  return domainType === "group_type_role" && authId >= INHERITED_RIGHT_MIN_AUTH_ID;
}

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
    // dataId is [] or a single element (CT reads scoped grants back one row per dataId), so there is
    // nothing to sort here — and tupleKey sorts defensively anyway when it builds the identity key.
    out.push({ authId: r.authId, dataId: r.dataId == null ? [] : [r.dataId], type: r.type });
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
