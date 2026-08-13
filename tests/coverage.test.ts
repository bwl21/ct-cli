/**
 * `ct coverage` (#103). The verdict half is what matters: whether a live (group, role) instance's
 * grants could be declared as config today, and — when they cannot — which scope dimension blocks it.
 * Everything here is offline: the report builder takes already-fetched rows.
 */
import { describe, it, expect } from "vitest";
import {
  buildCoverageReport,
  declarability,
  decodeGroupsWithRoles,
  renderCoverage,
  type GroupRow,
} from "../src/coverage/report.js";
import type { RawPermission } from "../src/permissions/grants.js";
import type { State } from "../src/state/state.js";

/** `churchgroup:view group` — `cdb_gruppe`, a dimension with a logical reference form (#98). */
const VIEW_GROUP = 1104;
/** `churchcore:use church html templates` — `cc_html_template`, module data with no resource behind it. */
const HTML_TEMPLATE = 17;
/** `churchcore:administer settings` — unscoped. */
const UNSCOPED = 1;

const row = (o: Partial<RawPermission> & { authId: number; domainId: number }): RawPermission => ({
  dataId: null,
  type: "grant",
  meta: { modifiedPid: 7 },
  ...o,
});

describe("declarability (#103)", () => {
  it("calls an unscoped + group-scoped role instance declarable", () => {
    const v = declarability([
      row({ authId: UNSCOPED, domainId: 1 }),
      row({ authId: VIEW_GROUP, dataId: 42, domainId: 1 }),
    ]);
    expect(v).toMatchObject({ declarable: true, grantCount: 2, blockedBy: [] });
  });

  it("names the blocking dimension rather than just saying no", () => {
    const v = declarability([
      row({ authId: VIEW_GROUP, dataId: 42, domainId: 1 }),
      row({ authId: HTML_TEMPLATE, dataId: 3, domainId: 1 }),
    ]);
    expect(v.declarable).toBe(false);
    expect(v.blockedBy).toEqual(["cc_html_template"]);
    // The count is of ALL authored grants, so "blocked by 1 of 2" is visible, not just "blocked".
    expect(v.grantCount).toBe(2);
  });

  it("excludes inherited rows and the system baseline from the authored count", () => {
    // Forgetting this filter is the exact mistake that inflated a hand-rolled audit from 590 to 714
    // grants and made several role instances look unmanageable that are not.
    const v = declarability([
      row({ authId: VIEW_GROUP, dataId: 42, domainId: 1 }),
      row({ authId: HTML_TEMPLATE, dataId: 3, domainId: 1, isInherited: true }),
      row({ authId: HTML_TEMPLATE, dataId: 4, domainId: 1, meta: { modifiedPid: -1 } }),
    ]);
    expect(v.grantCount).toBe(1);
    expect(v.declarable).toBe(true); // the only blocker was an inherited row ct never authors
  });

  it("treats the -1 ALL sentinel as declarable on any dimension", () => {
    const v = declarability([row({ authId: HTML_TEMPLATE, dataId: -1, domainId: 1 })]);
    expect(v.declarable).toBe(true);
  });

  it("blocks on a right the catalog cannot even name", () => {
    const v = declarability([row({ authId: 999_999, dataId: 1, domainId: 1 })]);
    expect(v.declarable).toBe(false);
    expect(v.unknownAuthIds).toEqual([999_999]);
  });
});

describe("buildCoverageReport (#103)", () => {
  const state: State = {
    version: 1,
    host: "h",
    resources: {
      struktur_a: { type: "group", id: 1, key: "struktur_a", fields: {}, adoptedAt: "t", updatedAt: "t" },
    },
  };
  const groups: GroupRow[] = [
    {
      id: 1,
      name: "Struktur A",
      groupTypeId: 9,
      roles: [
        { domainId: 100, groupId: 1, groupName: "Struktur A", groupTypeId: 9, roleName: "Leiter" },
        { domainId: 101, groupId: 1, groupName: "Struktur A", groupTypeId: 9, roleName: "Mitglied" },
      ],
    },
    {
      id: 2,
      name: "Local Lead B",
      groupTypeId: 12,
      roles: [{ domainId: 200, groupId: 2, groupName: "Local Lead B", groupTypeId: 12, roleName: "Leiter" }],
    },
    { id: 3, name: "Plain C", groupTypeId: 12, roles: [] },
  ];
  const report = buildCoverageReport({
    host: "h",
    state,
    groups,
    groupTypeNames: new Map([
      [9, "Struktur"],
      [12, "Local Lead"],
    ]),
    dynamicGroupIds: new Set([1, 3]),
    groupRolePermissions: [
      row({ authId: VIEW_GROUP, dataId: 42, domainId: 100 }),
      row({ authId: HTML_TEMPLATE, dataId: 3, domainId: 101 }),
      row({ authId: UNSCOPED, domainId: 200 }),
    ],
  });

  it("reports declarability PER (group, role), not per group", () => {
    // Struktur A has one declarable role and one blocked one — reporting at group granularity would
    // hide exactly that, which is why the unit is the role instance.
    const strukturA = report.roleInstances.filter((r) => r.groupId === 1);
    expect(strukturA.map((r) => [r.roleName, r.verdict.declarable])).toEqual([
      ["Leiter", true],
      ["Mitglied", false],
    ]);
    expect(report.grants).toMatchObject({ declarable: 2, blocked: 1, roleInstances: 3, authored: 3 });
  });

  it("collects every blocking dimension instance-wide", () => {
    expect(report.grants.blockingDimensions).toEqual(["cc_html_template"]);
  });

  it("counts managed / dynamic / unmanaged-with-grants per group type", () => {
    const byName = new Map(report.byType.map((t) => [t.name, t]));
    expect(byName.get("Struktur")).toMatchObject({
      total: 1,
      managed: 1,
      dynamic: 1,
      unmanagedWithGrants: 0,
    });
    // Group 2 is unmanaged AND carries grants — the "you are missing this" number. Group 3 is
    // unmanaged too but has no grants, so it must not inflate it.
    expect(byName.get("Local Lead")).toMatchObject({
      total: 2,
      managed: 0,
      dynamic: 1,
      unmanagedWithGrants: 1,
    });
  });

  it("skips role instances with no authored grants entirely", () => {
    expect(report.roleInstances.some((r) => r.groupId === 3)).toBe(false);
  });

  it("marks which role instances sit on a managed group", () => {
    expect(report.roleInstances.find((r) => r.domainId === 100)?.managedGroupKey).toBe("struktur_a");
    expect(report.roleInstances.find((r) => r.domainId === 200)?.managedGroupKey).toBeNull();
  });

  it("renders the totals, the per-type table and the blocking dimensions", () => {
    const text = renderCoverage(report);
    expect(text).toContain("3 groups · 1 managed · 3 authored grants over 3 role instances");
    expect(text).toContain("Struktur");
    expect(text).toContain("2 role instance(s) declarable · 1 blocked");
    expect(text).toContain("blocked by: cc_html_template");
  });
});

describe("decodeGroupsWithRoles (#103)", () => {
  it("reads groupTypeId from `information` and role names inline", () => {
    const [g] = decodeGroupsWithRoles(
      [{ id: 5, name: "Kids", information: { groupTypeId: 2 }, roles: [{ id: 77, name: "Leiter" }] }],
      new Map(),
    );
    expect(g).toMatchObject({ id: 5, groupTypeId: 2 });
    expect(g?.roles[0]).toMatchObject({ domainId: 77, roleName: "Leiter", groupId: 5 });
  });

  it("falls back to the /group/roles catalog when the role row carries no inline name", () => {
    const [g] = decodeGroupsWithRoles(
      [{ id: 5, name: "Kids", groupTypeId: 2, roles: [{ id: 77, groupTypeRoleId: 16 }] }],
      new Map([[16, "Organisator"]]),
    );
    expect(g?.roles[0]?.roleName).toBe("Organisator");
  });

  it("still counts a role whose name cannot be recovered — it has grants either way", () => {
    const [g] = decodeGroupsWithRoles([{ id: 5, name: "Kids", roles: [{ id: 77 }] }], new Map());
    expect(g?.roles[0]).toMatchObject({ domainId: 77, roleName: "role #77" });
  });
});
