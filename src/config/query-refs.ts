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
 *   - {@link portablizeRuleset}: the reverse-rewrite over caller-supplied catalogs (Stage 2).
 */
import type { GroupTypeRoleRef, RefKind, SimpleRef } from "../resolve/refs.js";
import type { RoleCatalogEntry } from "../resolve/reverse.js";

export type { RoleCatalogEntry };

/**
 * ChurchQuery `var` name → the {@link RefKind} its id operand denotes. The kinds are the canonical
 * RefKind strings the resolver already speaks (src/resolve/refs.ts) — do NOT invent new ones.
 *
 * Verified against the real captured prod rulesets (ct-structure/rulesets/*.json, 2026-07-11); the
 * entity-bearing vars present there that this simple name-based table covers are exactly these four:
 *   - `ctgroup.id`          → `group`      (a group's own id)
 *   - `ctgroup.campusId`    → `campus`
 *   - `ctgroup.groupTypeId` → `group-type`
 *   - `person.campusId`     → `campus`
 *
 * `role.id` is DELIBERATELY NOT here (fixed in #76, reverting #86's `role-def` mapping). A ruleset's
 * `role.id` is a **groupTypeRoleId** — a role scoped to a group TYPE — not a global role-catalog id.
 * Role NAMES are not globally unique across group types (live prod, 2026-07-11: 3 roles named "Leiter",
 * 6 "Organisator", 6 "Mitglied", each on a different group type), so mapping it to `role-def` (which
 * keys `/group/roles` by `slug(name)` alone) makes the resolver throw "ambiguous". Only the
 * (groupTypeId, name) PAIR is unique (0 collisions across all 46 prod roles), so `role.id` needs the
 * catalog-driven special case in {@link portablizeRuleset} that emits a `group-type-role` marker — a
 * lone name-based table entry cannot express it.
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
};

/**
 * The ChurchQuery `var` whose id operands are group-type-scoped role ids (`groupTypeRoleId`), handled
 * by the {@link portablizeRuleset} role special case rather than the name-based {@link VAR_REF_KINDS}
 * table (see the comment there for why). The same rewrite also covers the OUT-of-query
 * `process.*.handleMembership.groupTypeRoleId` integer field (see {@link ROLE_FIELD_NAME}).
 */
const ROLE_VAR = "role.id";

/**
 * The `process.*.handleMembership.groupTypeRoleId` object field: the target role a query-result-only /
 * group-and-query-result membership is granted with. It is a groupTypeRoleId just like a `role.id`
 * operand, but sits OUTSIDE the query subtree, so the walk rewrites it by object-key match, not by a
 * sibling `{ var }` leaf. Rewritten through the SAME role catalog + group-type map (#76).
 */
const ROLE_FIELD_NAME = "groupTypeRoleId";

/** An id left numeric because no managed logical key mapped to it — collected, not thrown (escape hatch). */
export interface PortablizeWarning {
  var: string;
  id: number;
}

export interface PortablizeOptions {
  /** Per-kind numeric-id → logical-key maps, supplied by the caller (from state/catalogs). Deterministic. */
  idToKeyByKind: Partial<Record<RefKind, Map<number, string>>>;
  /**
   * `/group/roles` catalog: groupTypeRoleId → {groupTypeId, name}, for rewriting `role.id` operands and
   * `handleMembership.groupTypeRoleId` fields (#76). Omit to leave every role id numeric (with a warning).
   */
  roleCatalog?: Map<number, RoleCatalogEntry>;
  /**
   * Managed group-type id → logical key, to reverse-map a role's `groupTypeId` to a portable group-type
   * key. A role whose group type is unmanaged (no key) is left numeric with a warning (escape hatch).
   */
  groupTypeIdToKey?: Map<number, string>;
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
 * so the same snapshot resolves per-host (#76 Stage 2). Pure and deterministic: the caller supplies the
 * id→key maps and the role catalog (from managed state / master-data catalogs) — no network, no mutation
 * of the input.
 *
 * Simple entity vars ({@link VAR_REF_KINDS}) rewrite off a sibling `{ var: <name> }` leaf: each numeric
 * id in the operand position becomes a `{ __ctRef, kind, key }` marker when it maps to a managed key,
 * else stays numeric and is reported in `warnings`. The `role.id` var and the out-of-query
 * `handleMembership.groupTypeRoleId` field are groupTypeRoleIds: each is looked up in `roleCatalog` to
 * recover its (groupTypeId, name), the groupTypeId is reverse-mapped to a managed group-type key, and a
 * `{ __ctRef, kind: "group-type-role", groupType, role }` marker is emitted (else numeric + warning).
 * Every other position — unknown vars (`groupStatusId`, `isArchived`, …), string labels, booleans —
 * passes through structurally unchanged. Expects a normalized ruleset (numeric-string ids already
 * coerced to numbers by src/engine/dynamic.ts `normalizeRuleset`, as the adopt path does).
 */
export function portablizeRuleset(
  ruleset: Record<string, unknown>,
  { idToKeyByKind, roleCatalog, groupTypeIdToKey }: PortablizeOptions,
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

  // A groupTypeRoleId → (group-type, role-name) marker, resolvable per host by the `group-type-role`
  // resolver. Leaves the id numeric (with a warning) when the role is unknown to the catalog or its
  // group type is unmanaged — the escape hatch, identical in spirit to mapScalar's.
  const mapRoleScalar = (value: unknown, varName: string): unknown => {
    if (typeof value !== "number") return value;
    const entry = roleCatalog?.get(value);
    const groupTypeKey = entry ? groupTypeIdToKey?.get(entry.groupTypeId) : undefined;
    if (entry && groupTypeKey !== undefined) {
      return {
        __ctRef: true,
        kind: "group-type-role",
        groupType: groupTypeKey,
        role: entry.name,
      } as GroupTypeRoleRef;
    }
    warnings.push({ var: varName, id: value });
    return value;
  };

  const mapOperand = (value: unknown, map: (v: unknown) => unknown): unknown =>
    Array.isArray(value) ? value.map(map) : map(value); // oneof id list vs `==` scalar

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      const varIdx = node.findIndex((el) => varNameOf(el) !== undefined);
      if (varIdx >= 0) {
        const varName = varNameOf(node[varIdx])!;
        const kind = VAR_REF_KINDS[varName];
        if (kind !== undefined) {
          // Known simple entity var: keep the `{ var }` leaf, rewrite the sibling id operand(s).
          return node.map((el, i) =>
            i === varIdx ? el : mapOperand(el, (v) => mapScalar(v, kind, varName)),
          );
        }
        if (varName === ROLE_VAR) {
          // Group-type-scoped role var (#76): rewrite siblings through the role catalog, not VAR_REF_KINDS.
          return node.map((el, i) => (i === varIdx ? el : mapOperand(el, (v) => mapRoleScalar(v, ROLE_VAR))));
        }
        // Unknown var (escape hatch) — recurse structurally, leaving its numeric ids untouched.
      }
      return node.map(walk);
    }
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        // `handleMembership.groupTypeRoleId` sits outside the query, so it has no `{ var }` leaf to key
        // off — rewrite it by object-key match, through the same role catalog as the `role.id` operand.
        out[k] =
          k === ROLE_FIELD_NAME && typeof v === "number"
            ? mapRoleScalar(v, ROLE_FIELD_NAME)
            : walk(v);
      }
      return out;
    }
    return node;
  };

  return { ruleset: walk(ruleset) as Record<string, unknown>, warnings };
}
