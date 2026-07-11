/**
 * Portable-ruleset ergonomics (#76, Stages 1–2): the `var → RefKind` catalog and the pure
 * `portablizeRuleset` reverse-rewrite helper. Everything here is offline and deterministic — the
 * caller supplies the per-kind id→key maps; no network, no live writes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { VAR_REF_KINDS, portablizeRuleset } from "../src/config/query-refs.js";
import { q, churchQuery } from "../src/config/query.js";
import { normalizeRuleset } from "../src/engine/dynamic.js";
import { deepMapRefs, type Ref, type RefKind } from "../src/resolve/refs.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("VAR_REF_KINDS catalog (#76 Stage 1)", () => {
  it("maps every ChurchQuery var observed in the captured prod rulesets to a real RefKind", () => {
    // Exactly the entity-bearing vars present in ct-structure/rulesets/*.json, verified against the
    // real files (2026-07-11): the four kinds are the canonical RefKind strings from src/resolve/refs.ts.
    expect(VAR_REF_KINDS).toEqual({
      "ctgroup.id": "group",
      "ctgroup.campusId": "campus",
      "ctgroup.groupTypeId": "group-type",
      "person.campusId": "campus",
      "role.id": "role-def",
    });
  });

  it("leaves non-entity and catalog-less vars OUT of the table (escape hatch)", () => {
    // groupStatusId has no REST catalog (#67) → never a managed entity; isArchived/dateOfDeath are
    // boolean/date literals. All three must be absent so portablize leaves their numbers untouched.
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
      idToKeyByKind: { group: new Map([[148, "jugend-mainz"], [1228, "jugend-berlin"]]) },
    });
    const filter = (out.query as { params: { filter: { oneof: unknown[] } } }).params.filter;
    expect(filter.oneof[0]).toEqual({ var: "ctgroup.id" });
    expect(filter.oneof[1]).toEqual([
      { __ctRef: true, kind: "group", key: "jugend-mainz" },
      { __ctRef: true, kind: "group", key: "jugend-berlin" },
    ]);
  });

  it("leaves an unmanaged id numeric and collects a { var, id } warning", () => {
    const ruleset = { query: churchQuery(q.oneof("ctgroup.id", [148, 999])) };
    const { ruleset: out, warnings } = portablizeRuleset(ruleset, {
      idToKeyByKind: { group: new Map([[148, "jugend-mainz"]]) },
    });
    const filter = (out.query as { params: { filter: { oneof: unknown[] } } }).params.filter;
    expect(filter.oneof[1]).toEqual([{ __ctRef: true, kind: "group", key: "jugend-mainz" }, 999]);
    expect(warnings).toEqual([{ var: "ctgroup.id", id: 999 }]);
  });

  it("never touches a catalog-less var (groupStatusId) — no rewrite, no warning", () => {
    const ruleset = { query: churchQuery(q.oneof("ctgroup.groupStatusId", [1, 2, 4])) };
    const { ruleset: out, warnings } = portablizeRuleset(ruleset, {
      idToKeyByKind: { group: new Map([[1, "nope"]]) },
    });
    const filter = (out.query as { params: { filter: { oneof: unknown[] } } }).params.filter;
    expect(filter.oneof[1]).toEqual([1, 2, 4]);
    expect(warnings).toEqual([]);
  });

  it("does not mutate its input ruleset", () => {
    const ruleset = { query: churchQuery(q.eq("ctgroup.campusId", 7)) };
    const before = JSON.stringify(ruleset);
    portablizeRuleset(ruleset, { idToKeyByKind: { campus: new Map([[7, "mainz"]]) } });
    expect(JSON.stringify(ruleset)).toEqual(before);
  });

  describe("real captured prod ruleset round-trip (sintegrationmeeting.json)", () => {
    const raw = JSON.parse(
      readFileSync(join(here, "fixtures/dynamic/portablize-sintegrationmeeting.json"), "utf8"),
    );
    // captureDynamic normalizes first (numeric-string ids → numbers), so Stage 2 runs on numbers.
    const normalized = normalizeRuleset(raw);

    // Every group/role id present in the fixture, mapped to a logical key.
    const groupIds = [148, 1228, 32, 1237, 1243, 27, 119, 1974];
    const roleIds = [16, 84, 85, 17, 90, 91, 15];
    const idToKeyByKind: Partial<Record<RefKind, Map<number, string>>> = {
      group: new Map(groupIds.map((id) => [id, `group-${id}`])),
      "role-def": new Map(roleIds.map((id) => [id, `role-${id}`])),
    };

    it("resolves byte-faithfully back to the original ids (round-trip)", () => {
      const { ruleset: portable } = portablizeRuleset(normalized, { idToKeyByKind });
      // Inverse map, applied with the SAME deepMapRefs the resolver uses — markers sit exactly where
      // the ids were, so the whole ruleset restores byte-identical to the normalized original.
      const keyToId = new Map<string, number>();
      for (const [id, key] of [...groupIds.map((id) => [id, `group-${id}`] as const)]) keyToId.set(`group:${key}`, id);
      for (const [id, key] of [...roleIds.map((id) => [id, `role-${id}`] as const)]) keyToId.set(`role-def:${key}`, id);
      const back = deepMapRefs(portable, (r: Ref) => keyToId.get(`${r.kind}:${(r as { key: string }).key}`));
      expect(back).toEqual(normalized);
    });

    it("leaves groupStatusId ids numeric with no warnings for them", () => {
      const { ruleset: portable, warnings } = portablizeRuleset(normalized, { idToKeyByKind });
      expect(JSON.stringify(portable)).toContain("[1,2,4]"); // the two groupStatusId oneof lists survive
      expect(warnings).toEqual([]); // every group/role id was mapped, statuses are never candidates
    });

    it("warns for each unmanaged group/role id when the maps are partial", () => {
      const partial: Partial<Record<RefKind, Map<number, string>>> = {
        group: new Map([[148, "group-148"]]),
        "role-def": new Map(),
      };
      const { warnings } = portablizeRuleset(normalized, { idToKeyByKind: partial });
      // Deterministic query-traversal order; groupStatusId ids (1,2,4) never appear.
      const ids = warnings.map((w) => w.id);
      expect(ids).toContain(1228);
      expect(ids).toContain(16);
      expect(ids).not.toContain(1); // groupStatusId never warns
      expect(warnings.every((w) => w.var === "ctgroup.id" || w.var === "role.id")).toBe(true);
    });
  });
});
