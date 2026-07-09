/**
 * Logical references (#20). A `Ref` is a leaf sentinel that stands in for a
 * ChurchTools numeric id the config author does not want to hardcode — a group
 * type by name, a campus by key, a permission domain by (group, role). It is the
 * one shared currency every id-bearing surface speaks: DSL id fields, query
 * `var` values, permission `domainId`.
 *
 * A config emits Refs at eval time (host-agnostic — no ids, no network). The
 * per-host {@link Resolver} (src/resolve/resolver.ts) turns each Ref into a
 * number at plan time, or into a `PendingRef` when it names a resource created
 * in the same run (id unknown until apply). Refs are leaf sentinels only: a Ref
 * never contains another Ref, and resolved ids are never written back to config.
 *
 * Two authoring forms compile to the same Refs:
 *  1. Named logical string fields on a declaration — `ct.group({ campus: "mainz" })`
 *     sugars into a Ref-valued `campusId` in `toDesired`.
 *  2. The explicit `ref.*` helper for inline positions — `ref.campus("mainz")`
 *     inside a query `var` value or `ct.groupTypeRole({ groupType: "…" })`.
 */

export type RefKind = "campus" | "group-type" | "group-status" | "role-def" | "group" | "group-role";

/** Simple key-addressed reference: campus / group type / group status / role definition / group. */
export interface SimpleRef {
  __ctRef: true;
  kind: "campus" | "group-type" | "group-status" | "role-def" | "group";
  key: string;
}

/** Compound reference: a permission `group_role` domain, addressed by its (group, role) pair. */
export interface GroupRoleRef {
  __ctRef: true;
  kind: "group-role";
  group: string;
  role: string;
}

export type Ref = SimpleRef | GroupRoleRef;

function requireKey(kind: RefKind, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`ref.${kind}: expected a non-empty string key, got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * The explicit reference helper for inline positions (query `var` values, permission domains).
 * Named-field sugar on declarations (`campus`/`groupType`/`status`) produces the same Refs.
 */
export const ref = {
  campus: (key: string): SimpleRef => ({ __ctRef: true, kind: "campus", key: requireKey("campus", key) }),
  groupType: (key: string): SimpleRef => ({ __ctRef: true, kind: "group-type", key: requireKey("group-type", key) }),
  status: (key: string): SimpleRef => ({ __ctRef: true, kind: "group-status", key: requireKey("group-status", key) }),
  roleDef: (key: string): SimpleRef => ({ __ctRef: true, kind: "role-def", key: requireKey("role-def", key) }),
  group: (key: string): SimpleRef => ({ __ctRef: true, kind: "group", key: requireKey("group", key) }),
  /**
   * GATED (#20/#25): the (group, role) pairing id has no confirmed API source, so the resolver
   * throws a clear "pass a numeric id" error at plan time. The Ref itself is inert until then.
   */
  groupRole: (group: string, role: string): GroupRoleRef => ({
    __ctRef: true,
    kind: "group-role",
    group: requireKey("group-role", group),
    role: requireKey("group-role", role),
  }),
};

export function isRef(value: unknown): value is Ref {
  return typeof value === "object" && value !== null && (value as { __ctRef?: unknown }).__ctRef === true;
}

/** Stable identity string for caching/deduping a Ref (not for display — see {@link refLabel}). */
export function refKey(r: Ref): string {
  return r.kind === "group-role" ? `group-role:${r.group} ${r.role}` : `${r.kind}:${r.key}`;
}

/** Human-readable label for error messages and plan rendering. */
export function refLabel(r: Ref): string {
  return r.kind === "group-role" ? `group-role(group=${r.group}, role=${r.role})` : `${r.kind}:${r.key}`;
}

/**
 * A same-run-created managed target: the Ref names a resource declared in this config but not yet
 * in state, so its id is unknown until the resource tier applies. Mirrors the permission scope
 * pending marker (src/permissions/scope.ts) — it renders in the plan and is re-resolved against
 * post-execute state at apply time (see {@link reresolvePendingValue} in resolver.ts).
 */
export interface PendingRef {
  __pendingRef: Ref;
}

export function pendingRef(r: Ref): PendingRef {
  return { __pendingRef: r };
}

export function isPendingRef(value: unknown): value is PendingRef {
  return (
    typeof value === "object" &&
    value !== null &&
    isRef((value as { __pendingRef?: unknown }).__pendingRef)
  );
}

/**
 * Deep-walk a value, replacing every leaf {@link Ref} with `fn(ref)` and passing everything else
 * through structurally. Rebuilds arrays/plain objects; Refs are leaves so recursion stops at them.
 */
export function deepMapRefs(value: unknown, fn: (r: Ref) => unknown): unknown {
  if (isRef(value)) return fn(value);
  if (Array.isArray(value)) return value.map((v) => deepMapRefs(v, fn));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepMapRefs(v, fn);
    return out;
  }
  return value;
}

/** Collect every {@link Ref} embedded in a value (deduping is the caller's job via {@link refKey}). */
export function collectRefs(value: unknown): Ref[] {
  const out: Ref[] = [];
  const walk = (v: unknown): void => {
    if (isRef(v)) {
      out.push(v);
      return; // Refs are leaves — never nested
    }
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v !== null && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };
  walk(value);
  return out;
}

/**
 * Collect the managed logical keys named by every {@link PendingRef} in a value. Pending markers
 * always point at a same-run declared resource, so these keys are exactly the apply-order
 * dependencies the referencing resource needs (group-role refs are gated and never go pending).
 */
export function collectPendingRefKeys(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (isPendingRef(v)) {
      const r = v.__pendingRef;
      if (r.kind !== "group-role") out.push(r.key);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v !== null && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };
  walk(value);
  return out;
}

/** True when a value contains at least one {@link PendingRef} marker (short-circuit for apply-time rewrite). */
export function hasPendingRef(value: unknown): boolean {
  if (isPendingRef(value)) return true;
  if (Array.isArray(value)) return value.some(hasPendingRef);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasPendingRef);
  }
  return false;
}
