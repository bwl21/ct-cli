import { describe, it, expect } from "vitest";
import { q, churchQuery } from "../src/config/query.js";
import { normalizeRuleset } from "../src/engine/dynamic.js";

describe("typed query builder", () => {
  it("builds a JSONLogic tree", () => {
    const tree = q.and(q.eq("ctgroup.campusId", 1), q.eq("person.isArchived", false));
    expect(tree).toEqual({ and: [
      { "==": [{ var: "ctgroup.campusId" }, 1] },
      { "==": [{ var: "person.isArchived" }, false] },
    ] });
  });

  it("oneof and isnull", () => {
    expect(q.oneof("ctgroup.groupTypeId", [1, 2])).toEqual({ oneof: [{ var: "ctgroup.groupTypeId" }, [1, 2]] });
    expect(q.isnull("person.isArchived")).toEqual({ isnull: [{ var: "person.isArchived" }] });
  });

  it("churchQuery wraps the filter in the real ChurchQuery envelope shape", () => {
    const cq = churchQuery(q.eq("ctgroup.campusId", 1), { description: "Mainz" });
    expect(cq).toEqual({
      description: "Mainz",
      method: "ChurchQuery",
      params: {
        groupBy: ["person.id"],
        filter: { "==": [{ var: "ctgroup.campusId" }, 1] },
        primaryEntityAlias: "person",
        responseFields: ["person.id", "person.firstName", "person.lastName"],
      },
    });
  });

  it("churchQuery defaults description to empty string and allows overriding envelope defaults", () => {
    const cq = churchQuery(q.isnull("person.dateOfDeath"), {
      groupBy: ["person.id", "ctgroup.id"],
      primaryEntityAlias: "ctgroup",
      responseFields: ["ctgroup.id"],
    });
    expect(cq).toEqual({
      description: "",
      method: "ChurchQuery",
      params: {
        groupBy: ["person.id", "ctgroup.id"],
        filter: { isnull: [{ var: "person.dateOfDeath" }] },
        primaryEntityAlias: "ctgroup",
        responseFields: ["ctgroup.id"],
      },
    });
  });

  it("a built ruleset normalizes stably (matches read-back normalization)", () => {
    const ruleset = { description: "x", importance: 0, personIdFieldName: "id",
      process: {}, query: churchQuery(q.eq("ctgroup.campusId", 1)) };
    expect(normalizeRuleset(normalizeRuleset(ruleset))).toEqual(normalizeRuleset(ruleset));
  });

  it("matches the shape of a real production ruleset's query envelope keys", () => {
    const cq = churchQuery(q.eq("ctgroup.campusId", 1));
    expect(Object.keys(cq).sort()).toEqual(["description", "method", "params"]);
    expect(Object.keys(cq.params as Record<string, unknown>).sort()).toEqual([
      "filter",
      "groupBy",
      "primaryEntityAlias",
      "responseFields",
    ]);
  });
});
