/**
 * Parametrized campus blueprint: define the Kids area once, instantiate per campus.
 * Demonstrates that the config DSL needs no special "blueprint" machinery — a
 * blueprint is a plain function over the injected context, called in a loop.
 */
import type { ConfigContext } from "../src/config/context.js";
import { q, churchQuery } from "../src/config/context.js";

const CAMPUSES = ["mainz", "berlin"] as const;

/** One campus's Kids area: a lead group with three ministry teams under it, plus a dynamic "all members" group. */
function kidsArea(ct: ConfigContext, campus: string): void {
  const lead = `${campus}_kids_lead`;
  ct.group({ key: lead, name: `${campus} · Kids Leitung`, groupTypeId: 2, parents: [] });
  for (const [suffix, label] of [["0_3", "0–3"], ["4_6", "4–6"], ["checkin", "Check-in"]] as const) {
    ct.group({
      key: `${campus}_kids_${suffix}`,
      name: `${campus} · Kids ${label}`,
      groupTypeId: 2,
      parents: [lead], // managed hierarchy: team sits under the campus lead group
    });
  }
  // A dynamic auto-group (#14) composed inside the blueprint.
  ct.group({
    key: `${campus}_kids_all`,
    name: `${campus} · Kids (alle)`,
    groupTypeId: 2,
    parents: [lead],
    dynamic: {
      status: "manual",
      ruleset: {
        description: `Alle aktiven Kids-Mitarbeiter ${campus}`,
        importance: 0,
        personIdFieldName: "person.id",
        process: {},
        query: churchQuery(q.eq("person.isArchived", false)),
      },
    },
  });
}

export default (ct: ConfigContext): void => {
  for (const campus of CAMPUSES) {
    ct.campus({ key: campus, name: `Campus ${campus}`, shorty: campus.slice(0, 3).toUpperCase() });
    kidsArea(ct, campus);
  }
  // A permission grant (#13) on a shared group-type-role template — id is an illustrative placeholder.
  // Both rights are scoped (they carry a `scopeField` in the catalog), so they must be declared
  // as `{ right, scope: [...] }` — a bare string would grant them globally and is rejected.
  const kidsLeads = CAMPUSES.map((c) => `${c}_kids_lead`);
  ct.groupTypeRole({
    key: "kids_lead_tpl",
    id: 2,
    grants: [
      { right: "churchgroup:view group", scope: kidsLeads },
      { right: "churchgroup:edit group memberships of group", scope: kidsLeads },
    ],
  });
};
