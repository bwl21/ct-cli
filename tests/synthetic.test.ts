import { describe, it, expect } from "vitest";
import { isSyntheticField, SYNTHETIC_FIELDS, foldSynthetic } from "../src/engine/synthetic.js";
import type { State } from "../src/state/state.js";
import type { DesiredResource } from "../src/engine/types.js";

describe("synthetic-field registry", () => {
  it("recognises registered pseudo-fields and nothing else", () => {
    expect(isSyntheticField("parents")).toBe(true);
    expect(SYNTHETIC_FIELDS.some((f) => f.field === "parents")).toBe(true);
    expect(isSyntheticField("name")).toBe(false);
  });

  it("parents fold folds managed hierarchy into desired + actual", async () => {
    const state: State = {
      version: 1,
      host: "h",
      resources: {
        child: {
          type: "group",
          id: 1311,
          key: "child",
          fields: { name: "child" },
          adoptedAt: "t",
          updatedAt: "t",
        },
        parent: {
          type: "group",
          id: 8,
          key: "parent",
          fields: { name: "parent" },
          adoptedAt: "t",
          updatedAt: "t",
        },
      },
    };
    const actual = new Map<string, Record<string, unknown>>([
      ["child", { name: "child" }],
      ["parent", { name: "parent" }],
    ]);
    const desired: DesiredResource[] = [
      { type: "group", key: "child", fields: { name: "child" }, parents: ["parent"], dependsOn: ["parent"] },
      { type: "group", key: "parent", fields: { name: "parent" }, dependsOn: [] },
    ];
    const client = {
      get: async <T>(): Promise<T> =>
        [
          { groupId: 1311, parents: [8], children: [] },
          { groupId: 8, children: [1311] },
        ] as unknown as T,
    };
    const out = await foldSynthetic({ client, state, desired, actual });
    expect(out.errors).toEqual([]);
    expect(actual.get("child")?.parents).toEqual(["parent"]);
    expect(out.desired[0]?.fields.parents).toEqual(["parent"]);
  });
});
