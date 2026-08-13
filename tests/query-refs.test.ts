/**
 * Portable-ruleset ergonomics (#76, Stages 1–2): the `var → RefKind` catalog and the pure
 * `portablizeRuleset` reverse-rewrite helper. Everything here is offline and deterministic — the
 * caller supplies the per-kind id→key maps and the role catalog; no network, no live writes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  VAR_REF_KINDS,
  formatPortablizeWarnings,
  portablizeRuleset,
  scanUnportablized,
  type RoleCatalogEntry,
} from "../src/config/query-refs.js";
import { q, churchQuery } from "../src/config/query.js";
import { normalizeRuleset } from "../src/engine/dynamic.js";
import { deepMapRefs, refKey, type Ref, type RefKind } from "../src/resolve/refs.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("VAR_REF_KINDS catalog (#76 Stage 1)", () => {
  it("maps every SIMPLE entity var observed in the captured prod rulesets to a real RefKind", () => {
    // Exactly the simple, name-based entity vars present in ct-structure/rulesets/*.json, verified
    // against the real files (2026-07-11). `role.id` is NOT here — it is a group-type-scoped role
    // (groupTypeRoleId) handled by the role special case in portablizeRuleset (see the test below and
    // the module comment), because role names are not globally unique across group types (#76).
    expect(VAR_REF_KINDS).toEqual({
      "ctgroup.id": "group",
      "ctgroup.campusId": "campus",
      "ctgroup.groupTypeId": "group-type",
      "person.campusId": "campus",
    });
  });

  it("leaves role.id, non-entity, and catalog-less vars OUT of the table", () => {
    // role.id is deliberately absent (fixed in #76, reverting #86's wrong `role-def` mapping): it needs
    // the (group-type, role-name) special case, not a lone name-based kind. groupStatusId has no REST
    // catalog (#67); isArchived/dateOfDeath are boolean/date literals.
    expect(VAR_REF_KINDS["role.id"]).toBeUndefined();
    expect(VAR_REF_KINDS["ctgroup.groupStatusId"]).toBeUndefined();
    expect(VAR_REF_KINDS["person.isArchived"]).toBeUndefined();
    expect(VAR_REF_KINDS["person.dateOfDeath"]).toBeUndefined();
  });
});

describe("portablizeRuleset (#76 Stage 2)", () => {
  it("rewrites a managed id in a `==` var position to the exact ref marker shape", () => {
    const ruleset = { query: churchQuery(q.eq("ctgroup.campusId", 7)) };
    const { ruleset: out, warnings } = portablizeRuleset(ruleset, {
      idToKeyByKind: { campus: new Map([[7, "mainz"]]) },
    });
    const filter = (out.query as { params: { filter: { "==": unknown[] } } }).params.filter;
    // Byte-identical to JSON.stringify(ref.campus("mainz")) — the marker isRef() already resolves.
    expect(filter["=="][1]).toEqual({ __ctRef: true, kind: "campus", key: "mainz" });
    expect(warnings).toEqual([]);
  });

  it("rewrites every managed id in a `oneof` id list and keeps operand order", () => {
    const ruleset = { query: churchQuery(q.oneof("ctgroup.id", [148, 1228])) };
    const { ruleset: out } = portablizeRuleset(ruleset, {
      idToKeyByKind: {
        group: new Map([
          [148, "jugend-mainz"],
          [1228, "jugend-berlin"],
        ]),
      },
    });
    const filter = (out.query as { params: { filter: { oneof: unknown[] } } }).params.filter;
    expect(filter.oneof[0]).toEqual({ var: "ctgroup.id" });
    expect(filter.oneof[1]).toEqual([
      { __ctRef: true, kind: "group", key: "jugend-mainz" },
      { __ctRef: true, kind: "group", key: "jugend-berlin" },
    ]);
  });

  it("leaves an unmanaged id numeric and collects a warning naming the reason (#101)", () => {
    const ruleset = { query: churchQuery(q.oneof("ctgroup.id", [148, 999])) };
    const { ruleset: out, warnings } = portablizeRuleset(ruleset, {
      idToKeyByKind: { group: new Map([[148, "jugend-mainz"]]) },
    });
    const filter = (out.query as { params: { filter: { oneof: unknown[] } } }).params.filter;
    expect(filter.oneof[1]).toEqual([{ __ctRef: true, kind: "group", key: "jugend-mainz" }, 999]);
    expect(warnings).toEqual([
      {
        var: "ctgroup.id",
        id: 999,
        reason: "unmanaged",
        detail: "not under management — `ct adopt group <id>` for each (then re-adopt) makes them portable",
      },
    ]);
  });

  it("never REWRITES a catalog-less var (groupStatusId), but does report it left numeric (#101)", () => {
    const ruleset = { query: churchQuery(q.oneof("ctgroup.groupStatusId", [1, 2, 4])) };
    const { ruleset: out, warnings } = portablizeRuleset(ruleset, {
      idToKeyByKind: { group: new Map([[1, "nope"]]) },
    });
    const filter = (out.query as { params: { filter: { oneof: unknown[] } } }).params.filter;
    expect(filter.oneof[1]).toEqual([1, 2, 4]); // never rewritten — no logical form exists
    // …but silence here is what #101 was filed about: the ids ARE host-specific, so they are reported.
    expect(warnings.map((w) => w.id)).toEqual([1, 2, 4]);
    expect(new Set(warnings.map((w) => w.reason))).toEqual(new Set(["no-ref-kind"]));
  });

  it("does not mutate its input ruleset", () => {
    const ruleset = { query: churchQuery(q.eq("ctgroup.campusId", 7)) };
    const before = JSON.stringify(ruleset);
    portablizeRuleset(ruleset, { idToKeyByKind: { campus: new Map([[7, "mainz"]]) } });
    expect(JSON.stringify(ruleset)).toEqual(before);
  });

  describe("role.id → (group-type, role-name) marker (#76 — the fix for #86's role-def mapping)", () => {
    // A `role.id` is a groupTypeRoleId: two ids can share a role NAME on different group types, so the
    // marker must carry the (group-type, role-name) pair, resolved via /group/roles by (groupTypeId, name).
    const roleCatalog = new Map<number, RoleCatalogEntry>([
      [84, { groupTypeId: 12, name: "Leiter" }],
      [16, { groupTypeId: 2, name: "Leiter" }], // SAME name as 84, different group type
    ]);
    const groupTypeIdToKey = new Map<number, string>([
      [12, "local_lead"],
      [2, "team"],
    ]);

    it("disambiguates two same-named roles by their group type", () => {
      const ruleset = { query: churchQuery(q.oneof("role.id", [84, 16])) };
      const { ruleset: out, warnings } = portablizeRuleset(ruleset, {
        idToKeyByKind: {},
        roleCatalog,
        groupTypeIdToKey,
      });
      const filter = (out.query as { params: { filter: { oneof: unknown[] } } }).params.filter;
      expect(filter.oneof[1]).toEqual([
        { __ctRef: true, kind: "group-type-role", groupType: "local_lead", role: "Leiter" },
        { __ctRef: true, kind: "group-type-role", groupType: "team", role: "Leiter" },
      ]);
      expect(warnings).toEqual([]);
    });

    it("leaves a role id whose group type is unmanaged numeric, with a { var: 'role.id' } warning", () => {
      const ruleset = { query: churchQuery(q.oneof("role.id", [84, 999])) };
      const { ruleset: out, warnings } = portablizeRuleset(ruleset, {
        idToKeyByKind: {},
        roleCatalog,
        groupTypeIdToKey,
      });
      const filter = (out.query as { params: { filter: { oneof: unknown[] } } }).params.filter;
      expect(filter.oneof[1]).toEqual([
        { __ctRef: true, kind: "group-type-role", groupType: "local_lead", role: "Leiter" },
        999, // not in roleCatalog → numeric
      ]);
      expect(warnings).toEqual([
        {
          var: "role.id",
          id: 999,
          reason: "role-unknown",
          detail: "no /group/roles row on this host carries these groupTypeRoleIds",
        },
      ]);
    });

    it("distinguishes 'role unknown' from 'role's group type unmanaged' (#101)", () => {
      const ruleset = { query: churchQuery(q.oneof("role.id", [84])) };
      const { warnings } = portablizeRuleset(ruleset, {
        idToKeyByKind: {},
        roleCatalog, // 84 → group type 12 …
        groupTypeIdToKey: new Map(), // … which is NOT managed here
      });
      expect(warnings).toEqual([
        {
          var: "role.id",
          id: 84,
          reason: "role-group-type-unmanaged",
          detail:
            "the role's group type is not managed — " +
            "adopt that group type to make the (group-type, role) pair portable",
        },
      ]);
    });

    it("leaves role.id numeric (with a warning) when no roleCatalog is supplied at all", () => {
      const ruleset = { query: churchQuery(q.oneof("role.id", [84])) };
      const { ruleset: out, warnings } = portablizeRuleset(ruleset, { idToKeyByKind: {} });
      const filter = (out.query as { params: { filter: { oneof: unknown[] } } }).params.filter;
      expect(filter.oneof[1]).toEqual([84]);
      expect(warnings).toEqual([
        {
          var: "role.id",
          id: 84,
          reason: "role-unknown",
          detail: "no /group/roles row on this host carries these groupTypeRoleIds",
        },
      ]);
    });
  });

  describe("process.*.handleMembership.groupTypeRoleId — an out-of-query role field (#76)", () => {
    const roleCatalog = new Map<number, RoleCatalogEntry>([[66, { groupTypeId: 9, name: "Mitglied" }]]);
    const groupTypeIdToKey = new Map<number, string>([[9, "struktur"]]);

    it("rewrites the integer field to a group-type-role marker via the same role catalog", () => {
      const ruleset = {
        query: churchQuery(q.eq("person.isArchived", 0)),
        process: {
          queryResultOnly: {
            none: { handleMembership: { groupMemberStatus: "active", groupTypeRoleId: 66 } },
          },
        },
      };
      const { ruleset: out, warnings } = portablizeRuleset(ruleset, {
        idToKeyByKind: {},
        roleCatalog,
        groupTypeIdToKey,
      });
      const hm = (out.process as { queryResultOnly: { none: { handleMembership: Record<string, unknown> } } })
        .queryResultOnly.none.handleMembership;
      expect(hm.groupTypeRoleId).toEqual({
        __ctRef: true,
        kind: "group-type-role",
        groupType: "struktur",
        role: "Mitglied",
      });
      expect(hm.groupMemberStatus).toBe("active"); // sibling string untouched
      expect(warnings).toEqual([]);
    });

    it("leaves the field numeric with a warning when the role is unknown", () => {
      const ruleset = {
        process: { queryResultOnly: { none: { handleMembership: { groupTypeRoleId: 4242 } } } },
      };
      const { ruleset: out, warnings } = portablizeRuleset(ruleset, {
        idToKeyByKind: {},
        roleCatalog,
        groupTypeIdToKey,
      });
      const hm = (out.process as { queryResultOnly: { none: { handleMembership: Record<string, unknown> } } })
        .queryResultOnly.none.handleMembership;
      expect(hm.groupTypeRoleId).toBe(4242);
      expect(warnings).toEqual([
        {
          var: "groupTypeRoleId",
          id: 4242,
          reason: "role-unknown",
          detail: "no /group/roles row on this host carries these groupTypeRoleIds",
        },
      ]);
    });
  });

  describe("real captured prod ruleset round-trip (skidscheckinopsmz.json)", () => {
    // The real ct-structure ruleset the #76 fix targets: ctgroup.id ["112","8","1246"], role.id
    // ["84","85","17","16"], and process...handleMembership.groupTypeRoleId 66 (OUT of the query).
    const raw = JSON.parse(
      readFileSync(join(here, "fixtures/dynamic/portablize-skidscheckinopsmz.json"), "utf8"),
    );
    // captureDynamic normalizes first (numeric-string ids → numbers), so Stage 2 runs on numbers.
    const normalized = normalizeRuleset(raw);

    // The real decode of the referenced ids (live prod /api/group/roles + /group/grouptypes, 2026-07-11).
    const roleCatalog = new Map<number, RoleCatalogEntry>([
      [84, { groupTypeId: 12, name: "Leiter" }],
      [85, { groupTypeId: 12, name: "Organisator" }],
      [16, { groupTypeId: 2, name: "Leiter" }],
      [17, { groupTypeId: 2, name: "Organisator" }],
      [66, { groupTypeId: 9, name: "Mitglied" }], // the process.groupTypeRoleId target
    ]);
    const groupTypeIdToKey = new Map<number, string>([
      [12, "local_lead"],
      [2, "team"],
      [9, "struktur"],
    ]);
    // Group 1246 is deliberately UNMANAGED (not in the map) — the escape hatch: it stays numeric.
    const idToKeyByKind: Partial<Record<RefKind, Map<number, string>>> = {
      group: new Map([
        [112, "bereich_kids"],
        [8, "team_kidsdienst"],
      ]),
    };
    const opts = { idToKeyByKind, roleCatalog, groupTypeIdToKey };

    it("produces (group-type, role-name) markers for the query roles AND the process groupTypeRoleId", () => {
      const { ruleset: portable } = portablizeRuleset(normalized, opts);
      const json = JSON.stringify(portable);
      // A query role marker (84 → local_lead/Leiter) and the process-field marker (66 → struktur/Mitglied).
      expect(json).toContain(
        '{"__ctRef":true,"kind":"group-type-role","groupType":"local_lead","role":"Leiter"}',
      );
      const hm = (
        portable.process as { queryResultOnly: { none: { handleMembership: Record<string, unknown> } } }
      ).queryResultOnly.none.handleMembership;
      expect(hm.groupTypeRoleId).toEqual({
        __ctRef: true,
        kind: "group-type-role",
        groupType: "struktur",
        role: "Mitglied",
      });
    });

    it("resolves byte-faithfully back to the original ids (round-trip, incl. process.groupTypeRoleId)", () => {
      const { ruleset: portable } = portablizeRuleset(normalized, opts);
      // Inverse map keyed by refKey — the identity string the resolver caches by — applied with the SAME
      // deepMapRefs the resolver uses. Markers sit exactly where the ids were, so the whole ruleset
      // (query filter AND the out-of-query process.groupTypeRoleId) restores byte-identical.
      const keyToId = new Map<string, number>();
      for (const [id, key] of [
        [112, "bereich_kids"],
        [8, "team_kidsdienst"],
      ] as const) {
        keyToId.set(refKey({ __ctRef: true, kind: "group", key }), id);
      }
      for (const [id, entry] of roleCatalog) {
        keyToId.set(
          refKey({
            __ctRef: true,
            kind: "group-type-role",
            groupType: groupTypeIdToKey.get(entry.groupTypeId)!,
            role: entry.name,
          }),
          id,
        );
      }
      const back = deepMapRefs(portable, (r: Ref) => keyToId.get(refKey(r)));
      expect(back).toEqual(normalized);
    });

    it("leaves the unmanaged group id (1246) and the groupStatusId lists numeric, and reports BOTH (#101)", () => {
      const { ruleset: portable, warnings } = portablizeRuleset(normalized, opts);
      const json = JSON.stringify(portable);
      expect(json).toContain("1246"); // unmanaged group id survives numeric
      expect(warnings).toContainEqual({
        var: "ctgroup.id",
        id: 1246,
        reason: "unmanaged",
        detail: "not under management — `ct adopt group <id>` for each (then re-adopt) makes them portable",
      });
      // groupStatusId is never REWRITTEN (no catalog exists) but is still a host-specific id in a
      // cross-host file, so #101 reports it rather than letting the capture look fully portable.
      expect(
        warnings.filter((w) => w.var === "ctgroup.groupStatusId").every((w) => w.reason === "no-ref-kind"),
      ).toBe(true);
      expect(warnings.some((w) => w.var === "ctgroup.groupStatusId")).toBe(true);
    });

    it("scanUnportablized reports the same ids from the ALREADY-PORTABLIZED file (#101 plan-time check)", () => {
      const { ruleset: portable } = portablizeRuleset(normalized, opts);
      const left = scanUnportablized(portable);
      // Every marker-rewritten id is gone from the report; the numeric leftovers remain.
      expect(left.some((w) => w.var === "ctgroup.id" && w.id === 1246)).toBe(true);
      expect(left.some((w) => w.id === 112 || w.id === 8)).toBe(false); // now `{ __ctRef }` markers
      expect(formatPortablizeWarnings(left).some((l) => l.startsWith("ctgroup.id: 1246 left numeric"))).toBe(
        true,
      );
    });

    // The scan has no state, no catalogs and no network, so it can prove POSITION and nothing else.
    // Reporting "unmanaged" from here told someone whose group IS adopted that it is not under
    // management — on every plan — and handed them a `ct adopt` that fails because it already is.
    it("reports only what position proves — never an unchecked 'unmanaged'/'role-unknown' verdict", () => {
      const left = scanUnportablized(normalized);
      expect(left.some((w) => w.var === "ctgroup.id")).toBe(true);
      expect(left.filter((w) => w.var === "ctgroup.id").every((w) => w.reason === "left-numeric")).toBe(true);
      expect(left.filter((w) => w.var === "role.id").every((w) => w.reason === "left-numeric")).toBe(true);
      expect(left.some((w) => /is not under management|no \/group\/roles row/.test(w.detail))).toBe(false);
      // The catalog-less dimension keeps its own reason: that one IS derivable without any lookup.
      expect(
        left.filter((w) => w.var === "ctgroup.groupStatusId").every((w) => w.reason === "no-ref-kind"),
      ).toBe(true);
    });
  });
});
