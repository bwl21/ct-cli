import { describe, it, expect } from "vitest";
import { resolveScope } from "../src/permissions/scope.js";
import type { State } from "../src/state/state.js";

const state: State = { version: 1, host: "h", resources: {
  kids_area: { type: "group", id: 42, key: "kids_area", fields: {}, adoptedAt: "t", updatedAt: "t" },
  other: { type: "group", id: 7, key: "other", fields: {}, adoptedAt: "t", updatedAt: "t" },
}};

describe("resolveScope", () => {
  it("maps managed group keys to resolutions sorted by id", () => {
    expect(resolveScope(["other", "kids_area"], state)).toEqual([
      { key: "other", id: 7 },
      { key: "kids_area", id: 42 },
    ]);
  });
  it("resolves a declared-but-not-yet-created group key to a pending (null id) resolution", () => {
    expect(resolveScope(["kids"], state, new Set(["kids"]))).toEqual([{ key: "kids", id: null }]);
  });
  it("orders resolved (in-state, by id) before pending (by key)", () => {
    expect(resolveScope(["pending_b", "kids_area", "pending_a"], state, new Set(["pending_a", "pending_b"]))).toEqual([
      { key: "kids_area", id: 42 },
      { key: "pending_a", id: null },
      { key: "pending_b", id: null },
    ]);
  });
  it("throws for a key that is neither in state nor declared", () => {
    expect(() => resolveScope(["nope"], state)).toThrow(/scope key "nope"/i);
  });

  it("passes a raw numeric scope entry through directly, without a state lookup (escape hatch, #49)", () => {
    expect(resolveScope([5, "kids_area"], state)).toEqual([
      { key: "5", id: 5, numeric: true },
      { key: "kids_area", id: 42 },
    ]);
  });

  it("sorts numeric and resolved group entries together, ascending by id", () => {
    expect(resolveScope(["kids_area", 3], state)).toEqual([
      { key: "3", id: 3, numeric: true },
      { key: "kids_area", id: 42 },
    ]);
  });

  it("rejects a non-positive-integer numeric scope entry", () => {
    expect(() => resolveScope([0], state)).toThrow(/numeric scope/i);
    expect(() => resolveScope([-3], state)).toThrow(/numeric scope/i);
    expect(() => resolveScope([1.5], state)).toThrow(/numeric scope/i);
  });
});
