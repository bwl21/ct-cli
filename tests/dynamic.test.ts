import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeRuleset, stripCosmeticLabels, coerceScalars, normalizeDynamic } from "../src/engine/dynamic.js";

describe("stripCosmeticLabels", () => {
  it("unwraps a dterm with a string label to its expr, recursively", () => {
    const input = { and: [{ dterm: ["Campus", { "==": [{ var: "ctgroup.campusId" }, 1] }] }] };
    expect(stripCosmeticLabels(input)).toEqual({ and: [{ "==": [{ var: "ctgroup.campusId" }, 1] }] });
  });
  it("unwraps a dterm with an object label (title/stereotype/i18n key)", () => {
    const input = { dterm: [{ title: "group.x.title", stereotype: ["groupmembership"] }, { isnull: [{ var: "person.dateOfDeath" }] }] };
    expect(stripCosmeticLabels(input)).toEqual({ isnull: [{ var: "person.dateOfDeath" }] });
  });
});

describe("coerceScalars", () => {
  it("coerces numeric strings to numbers so int/string drift is not spurious", () => {
    expect(coerceScalars({ "==": [{ var: "ctgroup.campusId" }, "1"] }))
      .toEqual({ "==": [{ var: "ctgroup.campusId" }, 1] });
  });
  it("coerces numeric strings inside oneof arrays but leaves non-numeric strings", () => {
    expect(coerceScalars({ oneof: [{ var: "ctgroup.id" }, ["112", "8"]] }))
      .toEqual({ oneof: [{ var: "ctgroup.id" }, [112, 8]] });
    expect(coerceScalars({ "==": [{ var: "groupmember.groupMemberStatus" }, "active"] }))
      .toEqual({ "==": [{ var: "groupmember.groupMemberStatus" }, "active"] });
  });
});

describe("normalizeRuleset", () => {
  it("drops read-only timestamps and the PUT envelope, and is idempotent", () => {
    const withEnvelope = { dynamicGroupRuleSet: { description: "x", dynamicGroupUpdateStarted: "t", process: {}, query: {} } };
    const once = normalizeRuleset(withEnvelope);
    expect(once).not.toHaveProperty("dynamicGroupUpdateStarted");
    expect(once).not.toHaveProperty("dynamicGroupRuleSet");
    expect(normalizeRuleset(once)).toEqual(once); // idempotent: read→normalize→normalize == normalize
  });

  it("unwraps the single-element array that GET returns", () => {
    const arr = [{ description: "x", process: {}, query: {} }];
    expect(normalizeRuleset(arr)).toEqual(normalizeRuleset(arr[0]));
  });

  it("coerces filter operands but leaves numeric-looking RuleSet-level fields as strings", () => {
    const r = { description: "2024", shorty: "007", personIdFieldName: "person.id",
      query: { "==": [{ var: "ctgroup.id" }, "112"] }, process: {} };
    const out = normalizeRuleset(r);
    expect(out.description).toBe("2024"); // stays a string, not 2024
    expect(out.shorty).toBe("007");       // stays a string, not 7
    expect(out.query).toEqual({ "==": [{ var: "ctgroup.id" }, 112] }); // filter operand coerced
  });

  it("read-then-normalize of every live fixture is stable and label-free", () => {
    for (const name of ["ruleset-683", "ruleset-2022", "ruleset-1092"]) {
      const raw = JSON.parse(readFileSync(`tests/fixtures/dynamic/${name}.get.json`, "utf8")); // array shape
      const once = normalizeRuleset(raw);
      expect(normalizeRuleset(once)).toEqual(once);                 // idempotent
      expect(JSON.stringify(once)).not.toContain("dterm");          // cosmetic labels stripped
    }
  });
});

describe("normalizeDynamic", () => {
  it("normalizes status + ruleset together", () => {
    const out = normalizeDynamic({ status: "manual", ruleset: { description: "x", query: {}, process: {} } });
    expect(out.status).toBe("manual");
    expect(out.ruleset).toHaveProperty("description", "x");
  });
});
