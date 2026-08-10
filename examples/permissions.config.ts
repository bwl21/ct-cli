/**
 * Runnable example: a group-type-role declaration with one unscoped (global)
 * grant and one scoped grant, plus a group-role declared by (group, role)
 * reference (#25). See docs/handbuch/permissions.md for the full feature guide, and
 * `ct get permissions-catalog` to discover right names.
 *
 * Portable references (#20): the permission domain is declared by name
 * (`groupType: "kids"`) instead of a hardcoded numeric domainId — the per-host
 * resolver maps it to that instance's group-type id at plan time. The numeric
 * escape hatch still works: pass `id: <domainId>` to target one directly (see
 * docs/handbuch/permissions.md "domainId semantics").
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
      // dataId, e.g. `scope: [1, 2]` — see docs/handbuch/permissions.md "Numeric scope
      // escape hatch (#49)".
      { right: "churchgroup:view group", scope: ["kids_area"] },
    ],
  });

  // group_role by reference (#25): the domain is declared by the (group, role)
  // pair instead of a numeric domainId. The group must be managed (declared
  // above / adopted) and already created; the resolver maps the pair to the
  // pairing domainId per host. Numeric escape hatch: `id: <domainId>` instead
  // of `group`/`role`. (See docs/handbuch/permissions.md "domainId semantics" for the
  // resolution assumption still to be confirmed live.)
  ct.groupRole({
    key: "kids_leiter_grant",
    group: "kids_area",
    role: "Leiter",
    grants: [{ right: "churchgroup:edit group memberships of group", scope: ["kids_area"] }],
  });

  // status (#90): the domain is a PERSON status, declared by name and resolved
  // against the live `/statuses` catalog per host (numeric escape hatch:
  // `id: <statusId>`). A grant here reaches EVERY person carrying that status,
  // so this is the instance-wide lever — there is deliberately no per-person
  // domain (people are never managed by this tool).
  //
  // `scope: [-1]` is ChurchTools' "all values of this dimension" sentinel — here
  // "every external system". CT reads -1 back verbatim, so it stays a no-op.
  ct.status({
    key: "core_external_login",
    personStatus: "5 - Core",
    grants: [{ right: "churchcore:login to external system", scope: [-1] }],
  });
};
