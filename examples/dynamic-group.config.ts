/**
 * Runnable example: a campus + a dynamic ("auto") group whose ruleset is
 * built with the typed query DSL. See docs/handbuch/dynamic-groups.md for the full
 * feature guide.
 *
 * Portable references (#20): the ruleset's `campusId` filter is written as a
 * logical `ref.campus("mainz")` instead of a hardcoded numeric id — the per-host
 * resolver fills in that instance's campus id at plan time. Here "mainz" is even
 * created in the same run, so the resolver links to its freshly-created id at
 * apply time. The numeric escape hatch still works: pass a plain number to `q.eq`.
 */
import type { ConfigContext } from "../src/config/context.js";
import { q, churchQuery, ref } from "../src/config/context.js";

export default (ct: ConfigContext): void => {
  ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });

  // The group must exist before it can carry a ruleset — the engine handles
  // this ordering automatically. `dynamic` is a synthetic sub-resource field
  // (like `parents`), not a separate resource type: its ruleset/status write is
  // folded into the group's OWN tier-1 apply and routed to the dynamic-group
  // endpoints inline (see src/engine/synthetic.ts and docs/handbuch/dynamic-groups.md).
  ct.group({
    key: "all_mainz",
    name: "Alle Mainz",
    groupTypeId: 1,
    dynamic: {
      // "manual": ChurchTools stores the ruleset but only recomputes
      // membership when explicitly triggered — via `ct apply --refresh` or
      // manually in the ChurchTools UI. Use "active" for continuous
      // automatic recomputation, "inactive" to keep the ruleset stored but
      // paused, or "none" to demote back to a plain (non-dynamic) group.
      status: "manual",
      ruleset: {
        // `description`/`shorty` live on the ruleset object itself — a
        // sibling of `query`, NOT an argument to churchQuery(...).
        description: "Alle aktiven Personen in Mainz",
        shorty: "Autom. Mitgliedschaft Alle Mainz",
        importance: 0,
        personIdFieldName: "person.id",
        process: {},
        query: churchQuery(
          q.and(q.eq("ctgroup.campusId", ref.campus("mainz")), q.eq("person.isArchived", false)),
        ),
      },
    },
  });
};
