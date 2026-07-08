import { describe, it, expect, vi } from "vitest";
import { desiredTuples, buildPermissionPlan } from "../src/permissions/plan.js";
import type { State } from "../src/state/state.js";

const state: State = { version: 1, host: "h", resources: {
  kids_area: { type: "group", id: 42, key: "kids_area", fields: {}, adoptedAt: "t", updatedAt: "t" },
  other: { type: "group", id: 7, key: "other", fields: {}, adoptedAt: "t", updatedAt: "t" },
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

  it("fans out a multi-element scope into one single-dataId tuple per dataId (idempotency: ChurchTools reads scoped grants back one row per dataId)", () => {
    const tuples = desiredTuples(
      { key: "t", domainType: "group_type_role", domainId: 8, grants: [
        { right: "churchgroup:view group", scope: ["kids_area", "other"] },
      ]}, state);
    // resolveScope sorts resolved dataIds ascending (7 < 42), independent of scope-key order.
    expect(tuples).toEqual([
      { authId: 1104, dataId: [7], type: "grant" },
      { authId: 1104, dataId: [42], type: "grant" },
    ]);
    expect(tuples.every((t) => t.dataId.length <= 1)).toBe(true);
  });

  it("rejects a scoped grant on a right with no scopeField", () => {
    // churchcore:administer settings has scopeField: null in the catalog — not a scoped right.
    expect(() => desiredTuples(
      { key: "t", domainType: "group_type_role", domainId: 8, grants: [
        { right: "churchcore:administer settings", scope: ["kids_area"] },
      ]}, state),
    ).toThrow(/not a scoped right/);
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

  it("multi-scope grant is idempotent against ChurchTools's one-row-per-dataId read shape (no churn)", async () => {
    const client = { get: vi.fn(async () => [
      { domainType: "group_type_role", domainId: 8, authId: 1104, dataId: 42, type: "grant", meta: { modifiedPid: 1 } },
      { domainType: "group_type_role", domainId: 8, authId: 1104, dataId: 7, type: "grant", meta: { modifiedPid: 1 } },
    ]) };
    const { items, fetchErrors } = await buildPermissionPlan(client as never, state,
      [{ key: "t", domainType: "group_type_role", domainId: 8, grants: [
        { right: "churchgroup:view group", scope: ["kids_area", "other"] },
      ]}]);
    expect(fetchErrors).toEqual([]);
    expect(items[0]?.diff.toPut).toEqual([]);
    expect(items[0]?.diff.toDelete).toEqual([]);
  });
});
