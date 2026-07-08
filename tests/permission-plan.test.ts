import { describe, it, expect, vi } from "vitest";
import { desiredTuples, buildPermissionPlan } from "../src/permissions/plan.js";
import type { State } from "../src/state/state.js";

const state: State = { version: 1, host: "h", resources: {
  kids_area: { type: "group", id: 42, key: "kids_area", fields: {}, adoptedAt: "t", updatedAt: "t" },
}};

describe("desiredTuples", () => {
  it("resolves names and scope to tuples", () => {
    const tuples = desiredTuples(
      { key: "t", domainType: "group_type_role", domainId: 8, grants: [
        "churchgroup:view group",                                   // authId 1104, unscoped
        { right: "churchgroup:view group", scope: ["kids_area"] },  // authId 1104, dataId [42]
      ]}, state);
    expect(tuples).toEqual([
      { authId: 1104, dataId: [], type: "grant" },
      { authId: 1104, dataId: [42], type: "grant" },
    ]);
  });
  it("rejects authId >= 10000 on group_type_role", () => {
    expect(() => desiredTuples({ key: "t", domainType: "group_type_role", domainId: 8, grants: ["churchdb:+see persons"] }, state))
      .toThrow(/10000/); // churchdb:+see persons is authId 10101
  });
});

describe("buildPermissionPlan", () => {
  it("diffs desired vs actual (bulk fetch filtered to managed domainIds)", async () => {
    const client = { get: vi.fn(async () => [
      { domainType: "group_type_role", domainId: 8, authId: 1104, dataId: null, type: "grant", meta: { modifiedPid: 1 } },
      { domainType: "group_type_role", domainId: 99, authId: 1, dataId: null, type: "grant", meta: { modifiedPid: 1 } }, // unmanaged domainId → ignored
    ]) };
    const { items, fetchErrors } = await buildPermissionPlan(client as never, state,
      [{ key: "t", domainType: "group_type_role", domainId: 8, grants: ["churchgroup:view group"] }]);
    expect(fetchErrors).toEqual([]);
    expect(items[0]?.diff.toPut).toEqual([]);     // 1104 unscoped already present
    expect(items[0]?.diff.toDelete).toEqual([]);  // domainId 99 is unmanaged → invisible
  });
});
