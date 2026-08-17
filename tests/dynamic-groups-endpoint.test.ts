/**
 * `GET /dynamicgroups` returns a flat array of GROUP IDS, not objects (#113/#124).
 *
 * Both consumers used to read it as `Number(row.id ?? row.groupId)` — `NaN` for every element — so
 * the id set was empty on every host: `ct coverage` reported `dynamic: 0` on an instance with 70
 * auto-groups, and `ct refresh` refused every group as "not a dynamic group". These tests pin the
 * scalar shape so it cannot be re-broken silently.
 */
import { describe, it, expect } from "vitest";
import { dynamicGroupRowId, parseDynamicGroupIds, fetchDynamicGroupIds } from "../src/api/dynamicGroups.js";
import { buildCoverageReport, type GroupRow } from "../src/coverage/report.js";
import type { State } from "../src/state/state.js";

describe("parseDynamicGroupIds (#124)", () => {
  it("reads the bare-integer array the endpoint actually returns", () => {
    // Verbatim from a live host, CT 3.135.2.
    const ids = parseDynamicGroupIds([159, 1698, 1704, 1707, 1710, 1713, 1740, 1748, 1753]);
    expect(ids.size).toBe(9);
    expect(ids.has(1753)).toBe(true);
  });

  it("still reads an object form, in either spelling", () => {
    expect([...parseDynamicGroupIds([{ id: 12 }, { groupId: 34 }])]).toEqual([12, 34]);
  });

  it("accepts numeric strings, which CT is prone to elsewhere", () => {
    expect([...parseDynamicGroupIds(["1753"])]).toEqual([1753]);
  });

  it("skips rows that yield no finite id instead of poisoning the set with NaN", () => {
    const ids = parseDynamicGroupIds([null, undefined, {}, "nope", 7]);
    expect([...ids]).toEqual([7]);
    expect([...ids].every(Number.isFinite)).toBe(true);
  });

  it("dynamicGroupRowId reports the miss rather than returning NaN", () => {
    expect(dynamicGroupRowId({})).toBeUndefined();
    expect(dynamicGroupRowId(1753)).toBe(1753);
  });

  it("fetchDynamicGroupIds asks the endpoint once and un-paged", async () => {
    const calls: string[] = [];
    const client = {
      getAll: async (path: string) => {
        calls.push(path);
        return { data: [1, 2, 3], meta: {} };
      },
    } as unknown as Parameters<typeof fetchDynamicGroupIds>[0];
    expect([...(await fetchDynamicGroupIds(client))]).toEqual([1, 2, 3]);
    expect(calls).toEqual(["/dynamicgroups"]);
  });
});

describe("coverage dynamic counts (#113)", () => {
  const group = (id: number, groupTypeId: number, name = `g${id}`): GroupRow => ({
    id,
    name,
    groupTypeId,
    roles: [],
  });

  it("counts dynamic and managedDynamic where the two sets only partially overlap", () => {
    // 5 groups; 3 are dynamic (2 Merkmal, 1 Struktur); 2 are managed, only ONE of which is dynamic.
    const groups = [group(1, 10), group(2, 10), group(3, 10), group(4, 20), group(5, 20)];
    const state: State = {
      version: 1,
      resources: {
        // #2 is dynamic AND managed — the managedDynamic case.
        merkmal_managed_dynamic: { type: "group", id: 2, fields: {} },
        // #5 is managed but NOT dynamic — must not inflate managedDynamic.
        struktur_managed_static: { type: "group", id: 5, fields: {} },
      },
    } as unknown as State;

    const report = buildCoverageReport({
      host: "https://example.church.tools",
      state,
      groups,
      groupTypeNames: new Map([
        [10, "Merkmal"],
        [20, "Struktur"],
      ]),
      dynamicGroupIds: new Set([2, 3, 4]),
      groupRolePermissions: [],
    });

    expect(report.groups).toMatchObject({ total: 5, dynamic: 3, managedDynamic: 1 });

    // Acceptance: the per-type `dynamic` column sums to the /dynamicgroups count.
    const perType = report.byType.reduce((sum, t) => sum + t.dynamic, 0);
    expect(perType).toBe(3);
    expect(report.byType.find((t) => t.name === "Merkmal")?.dynamic).toBe(2);
    expect(report.byType.find((t) => t.name === "Struktur")?.dynamic).toBe(1);
  });
});
