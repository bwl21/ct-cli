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
  // this ordering automatically (group is apply tier 1, the dynamic-group
  // ruleset/status write is tier 5; see TYPE_TIER in src/engine/graph.ts).
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
