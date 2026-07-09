/**
 * Runnable example: a group-type-role declaration with one unscoped (global)
 * grant and one scoped grant. See docs/permissions.md for the full feature
 * guide, and `ct get permissions-catalog` to discover right names.
 *
 * Portable references (#20): the permission domain is declared by name
 * (`groupType: "kids"`) instead of a hardcoded numeric domainId — the per-host
 * resolver maps it to that instance's group-type id at plan time. The numeric
 * escape hatch still works: pass `id: <domainId>` to target one directly (see
 * docs/permissions.md "domainId semantics").
 */
import type { ConfigContext } from "../src/config/context.js";

export default (ct: ConfigContext): void => {
  // The scoped grant below references this group by its logical key. Scope
  // keys must resolve to a group managed by this tool (declared or adopted),
  // so ct plan can show what the grant's scope resolves to. The group's own
  // type is named too — the resolver fills in the id per host.
  ct.group({ key: "kids_area", name: "Kids · Bereich", groupType: "kids" });

  ct.groupTypeRole({
    key: "leiter_tpl",
    groupType: "kids", // logical domain — the resolver maps it to the group type's id per host
    grants: [
      // Unscoped: applies everywhere this group type's role holds. authId 1101.
      "churchgroup:view",
      // Scoped: applies only to the listed managed group(s). authId 1104
      // (`scopeField: "cdb_gruppe"` in the catalog — a scoped right).
      // `scope` entries are logical group keys here; a right whose scopeField
      // is NOT a group (e.g. "cc_securitylevel") instead takes a raw numeric
      // dataId, e.g. `scope: [1, 2]` — see docs/permissions.md "Numeric scope
      // escape hatch (#49)".
      { right: "churchgroup:view group", scope: ["kids_area"] },
    ],
  });
};
