import { describe, it, expect, vi } from "vitest";
import { desiredTuples, buildPermissionPlan } from "../src/permissions/plan.js";
import { CATALOG_META } from "../src/permissions/catalog.js";
import { ref } from "../src/resolve/refs.js";
import type { State } from "../src/state/state.js";

const state: State = { version: 1, host: "h", resources: {
  kids_area: { type: "group", id: 42, key: "kids_area", fields: {}, adoptedAt: "t", updatedAt: "t" },
  other: { type: "group", id: 7, key: "other", fields: {}, adoptedAt: "t", updatedAt: "t" },
}};

describe("desiredTuples", () => {
  it("resolves names and scope to tuples", () => {
    const tuples = desiredTuples(
      { key: "t", domainType: "group_type_role", domainId: 8, grants: [
        "churchgroup:administer groups",                            // authId 1113, unscoped (no scopeField) → global
        { right: "churchgroup:view group", scope: ["kids_area"] },  // authId 1104, scoped, dataId [42]
      ]}, state);
    expect(tuples).toEqual([
      { authId: 1113, dataId: [], type: "grant" },
      { authId: 1104, dataId: [42], type: "grant", scopeKey: "kids_area" }, // scoped tuples retain their symbolic key for re-resolution
    ]);
  });

  it("rejects a bare-string scoped right — it would silently grant globally", () => {
    // churchgroup:view group carries scopeField "cdb_gruppe" (it IS scoped). Declared as a bare
    // string it would emit dataId: [] — a global grant. It must be declared as { right, scope }.
    expect(() => desiredTuples(
      { key: "t", domainType: "group_type_role", domainId: 8, grants: ["churchgroup:view group"] }, state),
    ).toThrow(/is a scoped right.*must be declared as \{ right/is);
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
      { authId: 1104, dataId: [7], type: "grant", scopeKey: "other" },
      { authId: 1104, dataId: [42], type: "grant", scopeKey: "kids_area" },
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

  it("accepts a raw numeric scope entry (escape hatch, #49) for a right scoped by a non-group dimension", () => {
    // churchdb:view comments (authId 113) is scoped by "cdb_comment_viewer" — not a group. There is
    // no managed-group representation for it, so the DSL's numeric escape hatch is the only way to
    // declare it. Numeric entries fan out just like logical keys, and MUST NOT retain a scopeKey —
    // there is no state resource to re-resolve at apply time.
    const tuples = desiredTuples(
      { key: "t", domainType: "group_type_role", domainId: 8, grants: [
        { right: "churchdb:view comments", scope: [1, 2] },
      ]}, state);
    expect(tuples).toEqual([
      { authId: 113, dataId: [1], type: "grant" },
      { authId: 113, dataId: [2], type: "grant" },
    ]);
    expect(tuples.every((t) => t.scopeKey === undefined)).toBe(true);
  });

  it("mixes a numeric scope entry with a logical group key in the same declaration", () => {
    const tuples = desiredTuples(
      { key: "t", domainType: "group_type_role", domainId: 8, grants: [
        { right: "churchgroup:view group", scope: ["kids_area", 3] },
      ]}, state);
    expect(tuples).toEqual([
      { authId: 1104, dataId: [3], type: "grant" },
      { authId: 1104, dataId: [42], type: "grant", scopeKey: "kids_area" },
    ]);
  });
});

describe("buildPermissionPlan", () => {
  it("diffs desired vs actual (bulk fetch filtered to managed domainIds)", async () => {
    const client = { get: vi.fn(async () => [
      { domainType: "group_type_role", domainId: 8, authId: 1113, dataId: null, type: "grant", meta: { modifiedPid: 1 } },
      { domainType: "group_type_role", domainId: 99, authId: 1, dataId: null, type: "grant", meta: { modifiedPid: 1 } }, // unmanaged domainId → ignored
    ]) };
    const { items, fetchErrors } = await buildPermissionPlan(client as never, state,
      [{ key: "t", domainType: "group_type_role", domainId: 8, grants: ["churchgroup:administer groups"] }]);
    expect(fetchErrors).toEqual([]);
    expect(items[0]?.diff.toPut).toEqual([]);     // 1113 unscoped already present
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

  it("resolves a group_role domain by (group, role) reference and reconciles idempotently (#25)", async () => {
    const client = { get: vi.fn(async (path: string) => {
      if (path === "/groups/42/roles") return [{ id: 2882, name: "Leiter" }];
      if (path === "/permissions/group_role") return [
        { domainType: "group_role", domainId: 2882, authId: 1104, dataId: 42, type: "grant", meta: { modifiedPid: 1 } },
      ];
      throw new Error(`unexpected path ${path}`);
    }) };
    // Declared with ZERO numeric ids: right name + group key + role name only.
    const { items, warnings, fetchErrors } = await buildPermissionPlan(client as never, state, [
      { key: "kids_lead", domainType: "group_role", domainId: ref.groupRole("kids_area", "Leiter"),
        grants: [{ right: "churchgroup:view group", scope: ["kids_area"] }] },
    ]);
    expect(fetchErrors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(items[0]?.domainId).toBe(2882);          // resolved from the (group, role) pair
    expect(items[0]?.diff.toPut).toEqual([]);        // adopted live row already matches → no-op
    expect(items[0]?.diff.toDelete).toEqual([]);
  });

  it("warns and never revokes a live grant whose authId is unknown to the catalog (#25)", async () => {
    const client = { get: vi.fn(async () => [
      { domainType: "group_type_role", domainId: 8, authId: 1113, dataId: null, type: "grant", meta: { modifiedPid: 1 } },   // known + desired
      { domainType: "group_type_role", domainId: 8, authId: 987654, dataId: null, type: "grant", meta: { modifiedPid: 1 } }, // unknown authId
    ]) };
    const { items, warnings } = await buildPermissionPlan(client as never, state,
      [{ key: "t", domainType: "group_type_role", domainId: 8, grants: ["churchgroup:administer groups"] }]);
    expect(items[0]?.diff.toDelete).toEqual([]); // the unnameable grant is NOT proposed for revocation
    expect(items[0]?.diff.toPut).toEqual([]);
    expect(warnings.some((w) => w.includes("987654") && w.includes("group_type_role #8"))).toBe(true);
  });

  it("excludes inherited rights (authId >= 10000) from the ACTUAL diff set on group_type_role (#65)", async () => {
    // eqrm prod, group_type_role 9: 5 writable user grants are declared, but the domain also reads
    // back inherited churchdb:+… rows (authId >= 10000) that CANNOT be declared (desiredTuples
    // rejects them) nor adopted (emitted as NOTE comments). If those live rows entered the ACTUAL
    // set they would have no desired counterpart and land in toDelete — the #65 bug ("0 to grant,
    // 24 to remove", a no-op that can never converge). They must be excluded from the diff.
    const client = { get: vi.fn(async () => [
      // the one writable, user-authored grant that IS declared
      { domainType: "group_type_role", domainId: 9, authId: 1113, dataId: null, type: "grant", meta: { modifiedPid: 5 } },
      // inherited-only rows (authId >= 10000): unscoped, scoped [1], scoped [2]
      { domainType: "group_type_role", domainId: 9, authId: 10101, dataId: null, type: "grant", meta: { modifiedPid: 5 } },
      { domainType: "group_type_role", domainId: 9, authId: 10102, dataId: 1, type: "grant", meta: { modifiedPid: 5 } },
      { domainType: "group_type_role", domainId: 9, authId: 10133, dataId: 2, type: "grant", meta: { modifiedPid: 5 } },
    ]) };
    const { items, warnings, fetchErrors } = await buildPermissionPlan(client as never, state,
      [{ key: "struktur", domainType: "group_type_role", domainId: 9, grants: ["churchgroup:administer groups"] }]);
    expect(fetchErrors).toEqual([]);
    expect(items[0]?.diff.toPut).toEqual([]);    // the declared writable grant already matches
    expect(items[0]?.diff.toDelete).toEqual([]); // NONE of the inherited rows are proposed for revocation
    // a single informational summary line, not one warning per inherited row
    const inheritedWarnings = warnings.filter((w) => w.includes("inherited right"));
    expect(inheritedWarnings).toHaveLength(1);
    expect(inheritedWarnings[0]).toMatch(/group_type_role #9.*3 inherited right/);
  });

  it("group_role does NOT exclude authId >= 10000 — only group_type_role inherits (#65)", async () => {
    // The predicate is domain-scoped: on group_role the churchdb:+… rights ARE writable/declarable,
    // so a live one that is undeclared must still be revoked (no accidental blanket exclusion).
    const client = { get: vi.fn(async (path: string) => {
      if (path === "/groups/42/roles") return [{ id: 2882, name: "Leiter" }];
      if (path === "/permissions/group_role") return [
        { domainType: "group_role", domainId: 2882, authId: 10122, dataId: null, type: "grant", meta: { modifiedPid: 5 } },
      ];
      throw new Error(`unexpected path ${path}`);
    }) };
    const { items } = await buildPermissionPlan(client as never, state, [
      { key: "kids_lead", domainType: "group_role", domainId: ref.groupRole("kids_area", "Leiter"), grants: [] },
    ]);
    expect(items[0]?.diff.toDelete).toEqual([{ authId: 10122, dataId: [], type: "grant" }]);
  });

  it("still revokes a REAL user-authored grant (authId < 10000) that is undeclared (#65 guard)", async () => {
    // Regression guard: the inherited-rights exclusion must NOT swallow ordinary undeclared grants —
    // those are exactly the drift a plan is meant to surface as a revoke.
    const client = { get: vi.fn(async () => [
      { domainType: "group_type_role", domainId: 9, authId: 1113, dataId: null, type: "grant", meta: { modifiedPid: 5 } }, // declared
      { domainType: "group_type_role", domainId: 9, authId: 1104, dataId: 42, type: "grant", meta: { modifiedPid: 5 } },   // undeclared user grant
      { domainType: "group_type_role", domainId: 9, authId: 10101, dataId: null, type: "grant", meta: { modifiedPid: 5 } }, // inherited → excluded
    ]) };
    const { items } = await buildPermissionPlan(client as never, state,
      [{ key: "struktur", domainType: "group_type_role", domainId: 9, grants: ["churchgroup:administer groups"] }]);
    expect(items[0]?.diff.toDelete).toEqual([{ authId: 1104, dataId: [42], type: "grant" }]);
  });

  it("warns when the instance CT version differs from the catalog's recorded version (#25)", async () => {
    const client = { get: vi.fn(async () => []) };
    const { warnings } = await buildPermissionPlan(client as never, state,
      [{ key: "t", domainType: "group_type_role", domainId: 8, grants: ["churchgroup:administer groups"] }],
      [], undefined, "9.99.0");
    expect(warnings.some((w) => /catalog was captured from ChurchTools .* but this instance\s+runs 9\.99\.0/is.test(w))).toBe(true);
  });

  it("does NOT warn about staleness when the instance version matches the catalog version (#25)", async () => {
    const client = { get: vi.fn(async () => []) };
    const { warnings } = await buildPermissionPlan(client as never, state,
      [{ key: "t", domainType: "group_type_role", domainId: 8, grants: ["churchgroup:administer groups"] }],
      [], undefined, CATALOG_META!.ctVersion);
    expect(warnings).toEqual([]);
  });
});
