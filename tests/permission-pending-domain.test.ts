/**
 * Pending permission domains (#69): a permission domain declared BY REFERENCE to a group type that
 * is created in the SAME run must NOT abort the plan. Instead it plans as a pending grant block and
 * reconciles at apply time once the group type has a fresh id — mirroring resource pending refs
 * (#20/#46) and the scope pending path (#29). This is the #23 fresh-instance rehearsal scenario.
 *
 * Exercises the REAL build → execute → apply sequence with a mock client, so convergence in ONE
 * `ct apply` run is proven end-to-end. No live instance.
 */
import { describe, it, expect, vi } from "vitest";
import { buildPermissionPlan } from "../src/permissions/plan.js";
import { applyPermissionPlan } from "../src/permissions/apply.js";
import { renderPermissionPlan } from "../src/permissions/render.js";
import { executePlan } from "../src/engine/execute.js";
import { emptyState, type State } from "../src/state/state.js";
import { ref } from "../src/resolve/refs.js";
import { Resolver } from "../src/resolve/resolver.js";
import type { Plan, DesiredResource } from "../src/engine/types.js";
import type { DesiredPermission } from "../src/permissions/types.js";
import type { CtClient } from "../src/api/ctClient.js";

const HOST = "https://mychurch.church.tools";
const STRUKTUR_TYPE_ID = 9;

// The #23 config, in miniature: declare a group type AND a group_type_role permission domain that
// references it by name — with ZERO numeric ids. "churchgroup:administer groups" is authId 1113,
// unscoped (global).
const strukturType: DesiredResource[] = [
  { type: "group-type", key: "struktur", fields: { name: "Struktur" }, dependsOn: [] },
];
const strukturPerm: DesiredPermission = {
  key: "struktur_roles",
  domainType: "group_type_role",
  domainId: ref.groupType("struktur"),
  grants: ["churchgroup:administer groups"],
};
const createStrukturPlan: Plan = {
  items: [
    {
      type: "group-type",
      key: "struktur",
      id: null,
      action: "create",
      changes: [{ field: "name", from: undefined, to: "Struktur" }],
    },
  ],
};

/** A mock client: POST /group/grouptypes mints STRUKTUR_TYPE_ID; GETs return whatever `perms` maps. */
function mockClient(perms: Record<string, unknown[]> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (method === "POST" && path === "/group/grouptypes") return { id: STRUKTUR_TYPE_ID };
    return {};
  });
  const get = vi.fn(async (path: string) => (perms[path] ?? []) as unknown[]);
  return { client: { request, get } as unknown as CtClient, calls, get };
}

describe("pending domain: declare group type + grant by reference in one config (#69/#23)", () => {
  it("plans from EMPTY state without aborting — a pending grant block, not the hard error", async () => {
    const { client, get } = mockClient();
    const { items, fetchErrors } = await buildPermissionPlan(
      client,
      emptyState(HOST),
      [strukturPerm],
      strukturType,
    );

    expect(fetchErrors).toEqual([]);
    // The domain is pending: no numeric id yet, the Ref is carried for apply-time re-resolution.
    expect(items[0]?.domainId).toBeNull();
    expect(items[0]?.pendingDomain).toEqual(ref.groupType("struktur"));
    // Every desired grant lands in toPut against an empty actual set (the type has no live grants).
    expect(items[0]?.diff.toPut).toEqual([{ authId: 1113, dataId: [], type: "grant" }]);
    expect(items[0]?.diff.toDelete).toEqual([]);
    // No /permissions fetch for a pending-only plan — nothing to fetch on a not-yet-created type.
    expect(get).not.toHaveBeenCalled();
    // Read-only render shows the pending marker, consistent with resource pending-ref rendering.
    expect(renderPermissionPlan(items)).toContain("<group-type:struktur (created this apply)>");
  });

  it("counts as a change for --detailed-exitcode / --json (toPut > 0)", async () => {
    const { client } = mockClient();
    const { items } = await buildPermissionPlan(client, emptyState(HOST), [strukturPerm], strukturType);
    const hasPermissionChanges = items.some((i) => i.diff.toPut.length > 0 || i.diff.toDelete.length > 0);
    expect(hasPermissionChanges).toBe(true);
    expect(items.reduce((n, i) => n + i.diff.toPut.length, 0)).toBe(1);
  });

  it("applies in ONE run — create then grant against the FRESH id — and a second plan is a no-op", async () => {
    const { client, calls } = mockClient();
    const state = emptyState(HOST);
    const { items } = await buildPermissionPlan(client, state, [strukturPerm], strukturType);

    // executePlan creates the group type and upserts its real id into state…
    await executePlan(createStrukturPlan, { client, state, statePath: "unused", save: async () => {} });
    expect(state.resources.struktur?.id).toBe(STRUKTUR_TYPE_ID);

    // …then permission reconciliation runs against POST-execute state and writes to the fresh domain.
    const res = await applyPermissionPlan(items, client, state);
    expect(res.granted).toBe(1);
    const put = calls.find(
      (c) => c.method === "PUT" && c.path === `/permissions/group_type_role/${STRUKTUR_TYPE_ID}`,
    );
    expect(put?.body).toEqual({ authId: 1113, type: "grant" }); // fresh domain id in the path, not a placeholder

    // Second plan (type now in state, grant now live) converges to a no-op — domain is concrete.
    const { client: c2 } = mockClient({
      "/permissions/group_type_role": [
        {
          domainType: "group_type_role",
          domainId: STRUKTUR_TYPE_ID,
          authId: 1113,
          dataId: null,
          type: "grant",
          meta: { modifiedPid: 1 },
        },
      ],
    });
    const { items: items2, fetchErrors } = await buildPermissionPlan(c2, state, [strukturPerm], strukturType);
    expect(fetchErrors).toEqual([]);
    expect(items2[0]?.domainId).toBe(STRUKTUR_TYPE_ID); // now concrete, not pending
    expect(items2[0]?.pendingDomain).toBeUndefined();
    expect(items2[0]?.diff.toPut).toEqual([]);
    expect(items2[0]?.diff.toDelete).toEqual([]);
    expect(renderPermissionPlan(items2)).toContain("No permission changes");
  });
});

describe("pending domain: prod-like scenario (type already in state) is unchanged (#69)", () => {
  it("resolves to the concrete domain id and reconciles idempotently — no pending path", async () => {
    const state: State = {
      version: 1,
      host: HOST,
      resources: {
        struktur: {
          type: "group-type",
          id: STRUKTUR_TYPE_ID,
          key: "struktur",
          fields: { name: "Struktur" },
          adoptedAt: "t",
          updatedAt: "t",
        },
      },
    };
    const { client } = mockClient({
      "/permissions/group_type_role": [
        {
          domainType: "group_type_role",
          domainId: STRUKTUR_TYPE_ID,
          authId: 1113,
          dataId: null,
          type: "grant",
          meta: { modifiedPid: 1 },
        },
      ],
    });
    const { items, fetchErrors } = await buildPermissionPlan(client, state, [strukturPerm], strukturType);
    expect(fetchErrors).toEqual([]);
    expect(items[0]?.domainId).toBe(STRUKTUR_TYPE_ID);
    expect(items[0]?.pendingDomain).toBeUndefined();
    expect(items[0]?.diff.toPut).toEqual([]);
    expect(items[0]?.diff.toDelete).toEqual([]);
  });
});

describe("group_role symmetry: a same-run group DOES go pending and completes in one apply (#106)", () => {
  // The domain half of #29's deadlock. A group_role domainId is the (group, role) PAIRING id, exposed
  // only on GET /groups/{id}/roles — so it cannot be completed from post-execute state alone the way a
  // group_type_role domain can. It is completed with a live fetch inside applyPermissionPlan instead.
  // Before #106 this was a hard error, which made the very same config plan clean on prod (group
  // exists) and exit 1 on dev (group does not) — non-portable by construction.
  const GROUP_ID = 4711;
  const PAIRING_ID = 44675;

  const declaredGroup: DesiredResource[] = [
    { type: "group", key: "kids_area", fields: { name: "Kids" }, dependsOn: [] },
  ];
  const grPerm: DesiredPermission = {
    key: "kids_lead",
    domainType: "group_role",
    domainId: ref.groupRole("kids_area", "Leiter"),
    grants: ["churchgroup:administer groups"],
  };
  const createGroupPlan: Plan = {
    items: [
      {
        type: "group",
        key: "kids_area",
        id: null,
        action: "create",
        changes: [{ field: "name", from: undefined, to: "Kids" }],
      },
    ],
  };

  /** Like `mockClient`, but POST /groups mints GROUP_ID and the group's role list is readable. */
  function groupClient(roles: unknown[] = [{ id: PAIRING_ID, name: "Leiter", groupTypeRoleId: 12 }]) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/groups") return { id: GROUP_ID };
      return {};
    });
    const get = vi.fn(async (path: string) => (path === `/groups/${GROUP_ID}/roles` ? roles : []));
    return { client: { request, get } as unknown as CtClient, calls, get };
  }

  it("plans from EMPTY state as a pending domain instead of the old hard error", async () => {
    const { client, get } = groupClient();
    const { items, fetchErrors } = await buildPermissionPlan(
      client,
      emptyState(HOST),
      [grPerm],
      declaredGroup,
    );

    expect(fetchErrors).toEqual([]);
    expect(items[0]?.domainId).toBeNull();
    expect(items[0]?.pendingDomain).toEqual(ref.groupRole("kids_area", "Leiter"));
    expect(items[0]?.diff.toPut).toEqual([{ authId: 1113, dataId: [], type: "grant" }]);
    // Nothing is fetched at plan time — the group does not exist yet, so neither does its role list.
    expect(get).not.toHaveBeenCalled();
    expect(renderPermissionPlan(items)).toContain(
      "<group-role(group=kids_area, role=Leiter) (created this apply)>",
    );
  });

  it("applies in ONE run — create the group, read its roles, grant on the pairing id", async () => {
    const { client, calls, get } = groupClient();
    const state = emptyState(HOST);
    const { items } = await buildPermissionPlan(client, state, [grPerm], declaredGroup);

    await executePlan(createGroupPlan, { client, state, statePath: "unused", save: async () => {} });
    expect(state.resources.kids_area?.id).toBe(GROUP_ID);

    const res = await applyPermissionPlan(items, client, state);
    expect(res.granted).toBe(1);
    expect(res.failed).toEqual([]);
    // The role list is read from the FRESHLY created group, and the pairing id — not the group id —
    // is what lands in the write path.
    expect(get).toHaveBeenCalledWith(`/groups/${GROUP_ID}/roles`);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe(`/permissions/group_role/${PAIRING_ID}`);
    expect(put?.body).toEqual({ authId: 1113, type: "grant" });
  });

  it("still hard-errors on a role the created group does not have, listing what it does have", async () => {
    const { client } = groupClient([
      { id: PAIRING_ID, name: "Mitglied" },
      { id: PAIRING_ID + 1, name: "Organisator" },
    ]);
    const state = emptyState(HOST);
    const { items } = await buildPermissionPlan(client, state, [grPerm], declaredGroup);
    await executePlan(createGroupPlan, { client, state, statePath: "unused", save: async () => {} });

    await expect(applyPermissionPlan(items, client, state)).rejects.toThrow(
      /group #4711 has no role named "Leiter" \(available: "Mitglied", "Organisator"\)/,
    );
  });

  it("is unchanged on a host where the group already exists — concrete domain, no pending path", async () => {
    const { client, get } = groupClient();
    const state: State = {
      version: 1,
      host: HOST,
      resources: {
        kids_area: {
          type: "group",
          id: GROUP_ID,
          key: "kids_area",
          fields: { name: "Kids" },
          adoptedAt: "t",
          updatedAt: "t",
        },
      },
    };
    const { items, fetchErrors } = await buildPermissionPlan(client, state, [grPerm], declaredGroup);
    expect(fetchErrors).toEqual([]);
    expect(items[0]?.pendingDomain).toBeUndefined();
    expect(items[0]?.domainId).toBe(PAIRING_ID);
    // Resolved at PLAN time here, from the already-existing group's role list.
    expect(get).toHaveBeenCalledWith(`/groups/${GROUP_ID}/roles`);
  });

  it("keeps the fail-fast message where a pending group_role can NOT be completed (query var)", async () => {
    // Only the permission-domain position opts into pending group-roles, because only it gets a live
    // fetch after the group exists. A group-role ref anywhere else keeps the old actionable error.
    const resolver = new Resolver({
      client: { get: async () => [] } as unknown as CtClient,
      state: emptyState(HOST),
      desired: declaredGroup,
    });
    await expect(
      resolver.resolve(ref.groupRole("kids_area", "Leiter"), 'dynamic group "x" var'),
    ).rejects.toThrow(/group "kids_area" is declared in this config but not yet created/);
  });
});

describe("pending domain: a TRUE typo (key absent from config AND state AND catalog) still hard-errors (#69)", () => {
  it("throws the resolver's unchanged notFound message — not a pending block", async () => {
    // "strucktur" is neither declared, nor in state, nor a live catalog match → genuinely unresolvable.
    const typoPerm: DesiredPermission = { ...strukturPerm, domainId: ref.groupType("strucktur") };
    const { client } = mockClient({ "/group/grouptypes": [{ id: STRUKTUR_TYPE_ID, name: "Struktur" }] });
    await expect(buildPermissionPlan(client, emptyState(HOST), [typoPerm], strukturType)).rejects.toThrow(
      /Cannot resolve group-type:strucktur referenced at group_type_role "struktur_roles".domainId/,
    );
  });
});
