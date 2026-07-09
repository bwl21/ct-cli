/**
 * Runnable example: a campus + a dynamic ("auto") group whose ruleset is
 * built with the typed query DSL. See docs/dynamic-groups.md for the full
 * feature guide.
 *
 * This is illustrative only — `mainzCampusId` below is a placeholder. In a
 * real config, resolve name → id lookups (e.g. from `ct get campuses`) at
 * config-build time before calling `q.eq`.
 */
import type { ConfigContext } from "../src/config/context.js";
import { q, churchQuery } from "../src/config/context.js";

const mainzCampusId = 0; // placeholder — replace with the real campus id

export default (ct: ConfigContext): void => {
  ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });

  // The group must exist before it can carry a ruleset — the engine handles
  // this ordering automatically. `dynamic` is a synthetic sub-resource field
  // (like `parents`), not a separate resource type: its ruleset/status write is
  // folded into the group's OWN tier-1 apply and routed to the dynamic-group
  // endpoints inline (see src/engine/synthetic.ts and docs/dynamic-groups.md).
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
          q.and(q.eq("ctgroup.campusId", mainzCampusId), q.eq("person.isArchived", false)),
        ),
      },
    },
  });
};
