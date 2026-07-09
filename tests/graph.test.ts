import { describe, it, expect } from "vitest";
import { orderKeys, tierOf, isKnownType, TYPE_TIER } from "../src/engine/graph.js";
import { RESOURCES } from "../src/resources/registry.js";
import type { DesiredResource } from "../src/engine/types.js";

function res(type: string, key: string, deps: string[] = [], parent?: string): DesiredResource {
  return { type, key, fields: {}, parent, dependsOn: parent ? [...deps, parent] : deps };
}

describe("tierOf", () => {
  it("ranks metadata below groups below the things that reference groups", () => {
    // Tiers are derived from the resource registry now; only real DesiredResource types have one.
    expect(tierOf("campus")).toBeLessThan(tierOf("group"));
    expect(tierOf("group-type")).toBeLessThan(tierOf("group"));
    expect(tierOf("group")).toBeLessThan(tierOf("group-role"));
    expect(tierOf("unknown")).toBe(0);
  });

  it("derives TYPE_TIER from the resource registry — exactly the registry types, no phantoms (#35 item 6)", () => {
    // The old hand-maintained table carried phantom types (group-status, group-hierarchy, permission,
    // dynamic-group) that are not DesiredResource types. Derivation keeps the two in lockstep.
    expect(Object.keys(TYPE_TIER).sort()).toEqual(Object.keys(RESOURCES).sort());
    for (const [type, spec] of Object.entries(RESOURCES)) {
      expect(TYPE_TIER[type]).toBe(spec.tier);
      expect(isKnownType(type)).toBe(true);
    }
    expect(isKnownType("group-status")).toBe(false); // phantom removed
  });
});

describe("orderKeys", () => {
  it("puts metadata before groups even without explicit edges", () => {
    const order = orderKeys([res("group", "team"), res("campus", "mainz"), res("group-type", "lead")]);
    expect(order.indexOf("mainz")).toBeLessThan(order.indexOf("team"));
    expect(order.indexOf("lead")).toBeLessThan(order.indexOf("team"));
  });

  it("orders parents before children regardless of declaration order", () => {
    const order = orderKeys([res("group", "child", [], "parent"), res("group", "parent")]);
    expect(order).toEqual(["parent", "child"]);
  });

  it("orders a permission after the group it depends on", () => {
    const order = orderKeys([res("permission", "perm", ["team"]), res("group", "team")]);
    expect(order).toEqual(["team", "perm"]);
  });

  it("ignores dependencies outside the managed set", () => {
    expect(orderKeys([res("group", "team", ["nonexistent"])])).toEqual(["team"]);
  });

  it("throws on a dependency cycle", () => {
    expect(() => orderKeys([res("group", "a", ["b"]), res("group", "b", ["a"])])).toThrow(/cycle/i);
  });
});
