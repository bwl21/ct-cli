import { describe, it, expect } from "vitest";
import { normalizeActual, diffGrants, tupleKey } from "../src/permissions/grants.js";

describe("normalizeActual", () => {
  it("coerces scalar dataId to a sorted array and drops baseline + inherited rows", () => {
    const rows = [
      { authId: 1104, dataId: 3, type: "grant" as const, domainId: 42, meta: { modifiedPid: 1 } },
      { authId: 1101, dataId: null, type: "grant" as const, domainId: 42, meta: { modifiedPid: 1 } },
      { authId: 9999, dataId: 1, type: "grant" as const, domainId: 42, meta: { modifiedPid: -1 } }, // system baseline → excluded
      { authId: 8888, dataId: 1, type: "grant" as const, domainId: 42, isInherited: true }, // inherited → excluded
    ];
    expect(normalizeActual(rows)).toEqual([
      { authId: 1104, dataId: [3], type: "grant" },
      { authId: 1101, dataId: [], type: "grant" },
    ]);
  });
});

describe("diffGrants", () => {
  it("adds missing, deletes extra, no-ops identical (order-independent dataId)", () => {
    const desired = [
      { authId: 1104, dataId: [7, 3], type: "grant" as const }, // present but reordered
      { authId: 1101, dataId: [], type: "grant" as const }, // new
    ];
    const actual = [
      { authId: 1104, dataId: [3, 7], type: "grant" as const }, // same tuple, different order
      { authId: 2000, dataId: [], type: "grant" as const }, // extra → delete
    ];
    const d = diffGrants(desired, actual);
    expect(d.toPut.map(tupleKey)).toEqual([tupleKey({ authId: 1101, dataId: [], type: "grant" })]);
    expect(d.toDelete.map(tupleKey)).toEqual([tupleKey({ authId: 2000, dataId: [], type: "grant" })]);
    expect(d.preserved).toEqual([]);
  });

  it("never deletes a pre-existing revoke (deny) row — surfaces it as preserved instead", () => {
    // desiredTuples only ever emits type:"grant", so a revoke row has no desired counterpart.
    // It must NOT land in toDelete (that would silently remove an admin's explicit deny).
    const desired = [{ authId: 1104, dataId: [3], type: "grant" as const }];
    const actual = [
      { authId: 1104, dataId: [3], type: "grant" as const }, // matched → no-op
      { authId: 1105, dataId: [7], type: "revoke" as const }, // pre-existing deny → preserved, never deleted
    ];
    const d = diffGrants(desired, actual);
    expect(d.toPut).toEqual([]);
    expect(d.toDelete).toEqual([]); // the revoke row is NOT deleted
    expect(d.preserved).toEqual([{ authId: 1105, dataId: [7], type: "revoke" }]);
  });
});
