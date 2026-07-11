/**
 * Portable-ruleset ergonomics (#76). A captured `dynamic: true` ruleset embeds ChurchQuery filters
 * that reference entities by raw numeric id (`ctgroup.id ∈ [148, …]`, `role.id ∈ [16, …]`). Those
 * ids are instance-specific, so a snapshot taken on prod is not portable to dev. The resolve/diff
 * engine ALREADY turns a logical `{ __ctRef }` marker anywhere in a ruleset into the per-host id
 * before the diff (src/resolve/refs.ts `collectRefs`/`deepMapRefs`, wired through src/engine/build.ts),
 * and the resolved form diffs byte-faithfully. The only missing piece is ergonomics: rewriting the
 * known-entity numeric ids a fresh capture carries into those markers. This module supplies the two
 * pure, offline pieces for that:
 *   - {@link VAR_REF_KINDS}: which ChurchQuery `var` maps to which {@link RefKind} (Stage 1), and
 *   - {@link portablizeRuleset}: the reverse-rewrite over a caller-supplied id→key map (Stage 2).
 */
import type { RefKind, SimpleRef } from "../resolve/refs.js";

/**
 * ChurchQuery `var` name → the {@link RefKind} its id operand denotes. The kinds are the canonical
 * RefKind strings the resolver already speaks (src/resolve/refs.ts) — do NOT invent new ones.
 *
 * Verified against the real captured prod rulesets (ct-structure/rulesets/*.json, 2026-07-11); the
 * full set of entity-bearing vars present there is exactly these five:
 *   - `ctgroup.id`          → `group`      (a group's own id)
 *   - `ctgroup.campusId`    → `campus`
 *   - `ctgroup.groupTypeId` → `group-type`
 *   - `person.campusId`     → `campus`
 *   - `role.id`             → `role-def`
 *
 * `role.id` is `role-def`, NOT `group-role`: the query filters on the GLOBAL role-catalog id
 * (`/group/roles`, exactly the catalog the resolver's `role-def` kind reads — see CATALOG_PATH in
 * src/resolve/resolver.ts), a single numeric id. `group-role` is a compound (group, role) permission
 * DOMAIN, addressed by a pair — a different currency that a lone `role.id` number cannot express.
 *
 * Deliberately absent (the escape hatch — unknown vars are left untouched by {@link portablizeRuleset}):
 *   - `ctgroup.groupStatusId` — group statuses have NO REST catalog (#67; `/group/memberstatus` is a
 *     different dimension). Not a managed entity → never rewritten, stays a plain number.
 *   - `person.isArchived`, `person.dateOfDeath` — boolean/date literals, not entity refs.
 */
export const VAR_REF_KINDS: Readonly<Record<string, RefKind>> = {
  "ctgroup.id": "group",
  "ctgroup.campusId": "campus",
  "ctgroup.groupTypeId": "group-type",
  "person.campusId": "campus",
  "role.id": "role-def",
};

/** An id left numeric because no managed logical key mapped to it — collected, not thrown (escape hatch). */
export interface PortablizeWarning {
  var: string;
  id: number;
}

export interface PortablizeOptions {
  /** Per-kind numeric-id → logical-key maps, supplied by the caller (from state/catalogs). Deterministic. */
  idToKeyByKind: Partial<Record<RefKind, Map<number, string>>>;
}

export interface PortablizeResult {
  ruleset: Record<string, unknown>;
  warnings: PortablizeWarning[];
}

/** A JSONLogic `{ var: "name" }` leaf — the sole shape that anchors an id operand to a known kind. */
function varNameOf(node: unknown): string | undefined {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
  const obj = node as Record<string, unknown>;
  return Object.keys(obj).length === 1 && typeof obj.var === "string" ? obj.var : undefined;
}

/**
 * Rewrite the known-entity numeric ids a captured ruleset carries into logical `{ __ctRef }` markers,
 * so the same snapshot resolves per-host (#76 Stage 2). Pure and deterministic: the caller supplies
 * `idToKeyByKind` (from managed state / master-data catalogs) — no network, no mutation of the input.
 *
 * The walk keys off JSONLogic operand arrays: an operator whose operands include a `{ var: <name> }`
 * leaf whose `<name>` is in {@link VAR_REF_KINDS} has its OTHER operands treated as id values (a
 * scalar for `==`, an array for `oneof`). Each numeric id in that position is replaced with the ref
 * marker when it maps to a managed key, else left numeric and reported in `warnings`. Every other
 * position — unknown vars (the escape hatch: `groupStatusId`, `isArchived`, …), string labels,
 * booleans — passes through structurally unchanged. Expects a normalized ruleset (numeric-string ids
 * already coerced to numbers by src/engine/dynamic.ts `normalizeRuleset`, as the adopt path does).
 */
export function portablizeRuleset(
  ruleset: Record<string, unknown>,
  { idToKeyByKind }: PortablizeOptions,
): PortablizeResult {
  const warnings: PortablizeWarning[] = [];

  const marker = (kind: RefKind, key: string): SimpleRef => ({ __ctRef: true, kind, key } as SimpleRef);

  const mapScalar = (value: unknown, kind: RefKind, varName: string): unknown => {
    if (typeof value !== "number") return value; // booleans/strings/nulls are literals, never entity ids
    const key = idToKeyByKind[kind]?.get(value);
    if (key !== undefined) return marker(kind, key);
    warnings.push({ var: varName, id: value });
    return value;
  };

  const mapValueOperand = (value: unknown, kind: RefKind, varName: string): unknown =>
    Array.isArray(value)
      ? value.map((el) => mapScalar(el, kind, varName)) // oneof id list
      : mapScalar(value, kind, varName); // == scalar

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      const varIdx = node.findIndex((el) => varNameOf(el) !== undefined);
      if (varIdx >= 0) {
        const varName = varNameOf(node[varIdx])!;
        const kind = VAR_REF_KINDS[varName];
        if (kind !== undefined) {
          // Known entity var: keep the `{ var }` leaf, rewrite the sibling id operand(s).
          return node.map((el, i) => (i === varIdx ? el : mapValueOperand(el, kind, varName)));
        }
        // Unknown var (escape hatch) — recurse structurally, leaving its numeric ids untouched.
      }
      return node.map(walk);
    }
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return node;
  };

  return { ruleset: walk(ruleset) as Record<string, unknown>, warnings };
}
