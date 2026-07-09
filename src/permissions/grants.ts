/**
 * Grant tuples and set reconciliation. A grant's identity is (authId, sorted dataId, type).
 * Actuals exclude the self-re-adding system baseline (modifiedPid === -1) and inherited rows,
 * so reconciliation owns only user-authored grants and never fights the platform.
 */
export type DomainType = "group_role" | "group_type_role";

export interface GrantTuple { authId: number; dataId: number[]; type: "grant" | "revoke" }
export interface RawPermission {
  authId: number; dataId: number | null; type: "grant" | "revoke"; domainId: number;
  isInherited?: boolean; meta?: { modifiedPid?: number };
}

export function tupleKey(t: { authId: number; dataId: number[]; type: string }): string {
  return `${t.type}:${t.authId}:${[...t.dataId].sort((a, b) => a - b).join(",")}`;
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
