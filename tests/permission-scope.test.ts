import { describe, it, expect } from "vitest";
import { resolveScope } from "../src/permissions/scope.js";
import type { State } from "../src/state/state.js";

const state: State = { version: 1, host: "h", resources: {
  kids_area: { type: "group", id: 42, key: "kids_area", fields: {}, adoptedAt: "t", updatedAt: "t" },
  other: { type: "group", id: 7, key: "other", fields: {}, adoptedAt: "t", updatedAt: "t" },
}};

describe("resolveScope", () => {
  it("maps managed group keys to sorted ids", () => {
    expect(resolveScope(["other", "kids_area"], state)).toEqual([7, 42]);
  });
  it("throws for a key that is not a managed group", () => {
    expect(() => resolveScope(["nope"], state)).toThrow(/scope key "nope"/i);
  });
});
