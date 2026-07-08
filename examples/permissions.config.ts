/**
 * Runnable example: a group-type-role declaration with one unscoped (global)
 * grant and one scoped grant. See docs/permissions.md for the full feature
 * guide, and `ct get permissions-catalog` to discover right names.
 *
 * This is illustrative only — the `id: 1` on `groupTypeRole` below is a
 * placeholder domainId (the group type's own id; see docs/permissions.md
 * "domainId semantics"). In a real config, use the actual group type id
 * (e.g. from `ct get group-types`).
 */
import type { ConfigContext } from "../src/config/context.js";

export default (ct: ConfigContext): void => {
  // The scoped grant below references this group by its logical key. Scope
  // keys must resolve to a group managed by this tool (declared or adopted),
  // so ct plan can show what the grant's scope resolves to.
  ct.group({ key: "kids_area", name: "Kids · Bereich", groupTypeId: 1 });

  ct.groupTypeRole({
    key: "leiter_tpl",
    id: 1, // placeholder — the real group type's id (e.g. from `ct get group-types`)
    grants: [
      // Unscoped: applies everywhere this group type's role holds. authId 1101.
      "churchgroup:view",
      // Scoped: applies only to the listed managed group(s). authId 1104
      // (`scopeField: "cdb_gruppe"` in the catalog — a scoped right).
      { right: "churchgroup:view group", scope: ["kids_area"] },
    ],
  });
};
