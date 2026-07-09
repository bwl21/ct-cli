/**
 * End-to-end coverage for portable logical references (#20): the resolver wired through buildPlan,
 * apply-time pending re-resolution in executePlan, permission domainId resolution, and the headline
 * acceptance test — one config yielding valid plans against two different hosts (states + catalogs).
 */
import { describe, it, expect } from "vitest";
import { evaluateConfig, q, churchQuery, ref } from "../src/config/context.js";
import { buildPlan } from "../src/engine/build.js";
import { executePlan } from "../src/engine/execute.js";
import { buildPermissionPlan } from "../src/permissions/plan.js";
import { Resolver } from "../src/resolve/resolver.js";
import { renderPlan } from "../src/engine/render.js";
import { CtApiError } from "../src/api/ctClient.js";
import { emptyState, type State } from "../src/state/state.js";

/** Fake client serving catalog/item GETs and recording write requests, returning canned POST ids. */
function fakeHost(catalogs: Record<string, unknown>, postIds: Record<string, number> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  return {
    calls,
    get: async <T>(path: string): Promise<T> => {
      if (!(path in catalogs)) throw new CtApiError(`not found: ${path}`, 404, null);
      return catalogs[path] as T;
    },
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      const id = postIds[`${method} ${path}`];
      return (id !== undefined ? { id } : {}) as T;
    },
  };
}

const noSave = async (): Promise<void> => {};

describe("buildPlan reference resolution", () => {
  it("resolves a catalog groupType ref to a number so the diff stays number↔number", async () => {
    const { resources } = await evaluateConfig((ct) => {
      ct.group({ key: "kids", name: "Kids", groupType: "ministry_team" });
    });
    const client = fakeHost({ "/group/grouptypes": [{ id: 2, name: "Ministry Team" }] });
    const { plan } = await buildPlan(client, emptyState("h"), resources);
    const item = plan.items.find((i) => i.key === "kids")!;
    expect(item.action).toBe("create");
    expect(item.changes).toContainEqual({ field: "groupTypeId", from: undefined, to: 2 });
  });

  it("renders a same-run campus reference as a pending marker", async () => {
    const { resources } = await evaluateConfig((ct) => {
      ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });
      ct.group({ key: "kids", name: "Kids", groupTypeId: 2, campus: "mainz" });
    });
    const client = fakeHost({});
    const { plan } = await buildPlan(client, emptyState("h"), resources);
    const rendered = renderPlan(plan);
    expect(rendered).toContain("campusId: <campus:mainz (created this apply)>");
  });

  it("throws a config error (not a fetchError) on an unresolvable reference", async () => {
    const { resources } = await evaluateConfig((ct) => {
      ct.group({ key: "kids", name: "Kids", groupType: "ghost_type" });
    });
    const client = fakeHost({ "/group/grouptypes": [{ id: 2, name: "Ministry Team" }] });
    await expect(buildPlan(client, emptyState("h"), resources)).rejects.toThrow(
      /Cannot resolve group-type:ghost_type referenced at group "kids"/,
    );
  });
});

describe("apply-time pending re-resolution (same-run campus + group)", () => {
  it("carries the freshly-created campus id into the group's POST body", async () => {
    const { resources } = await evaluateConfig((ct) => {
      ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });
      ct.group({ key: "kids", name: "Kids", groupTypeId: 2, campus: "mainz" });
    });
    const state = emptyState("h");
    const host = fakeHost({}, { "POST /campuses": 42, "POST /groups": 100 });
    const { plan } = await buildPlan(host, state, resources);

    await executePlan(plan, { client: host, state, statePath: "s.json", save: noSave, now: () => "t" });

    const campusPost = host.calls.find((c) => c.path === "/campuses")!;
    expect(campusPost.method).toBe("POST");
    const groupPost = host.calls.find((c) => c.path === "/groups")!;
    // The group POST body carries the campus's freshly created id (42), not the pending sentinel.
    expect(groupPost.body).toEqual({ name: "Kids", groupTypeId: 2, campusId: 42 });
    // State records the resolved id too (no pending marker leaks into state).
    expect(state.resources.kids?.fields).toMatchObject({ campusId: 42 });
  });

  it("resolves a same-run ref embedded in a dynamic ruleset before the ruleset PUT", async () => {
    // The dynamic group is already managed (a fresh dynamic group is a two-apply flow); the campus it
    // filters on is added to the config now, so its ruleset ref is same-run pending until apply time.
    const { resources } = await evaluateConfig((ct) => {
      ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });
      ct.group({
        key: "all_mainz",
        name: "All",
        groupTypeId: 1,
        dynamic: {
          status: "manual",
          ruleset: { query: churchQuery(q.eq("ctgroup.campusId", ref.campus("mainz"))) },
        },
      });
    });
    const state = emptyState("h");
    state.resources.all_mainz = {
      type: "group", id: 100, key: "all_mainz", fields: { name: "All", groupTypeId: 1 }, adoptedAt: "t", updatedAt: "t",
    };
    // /groups/100 fetches clean; its ruleset 404s (not yet a dynamic group) → the manual ruleset is a change.
    const host = fakeHost({ "/groups/100": { name: "All", groupTypeId: 1 } }, { "POST /campuses": 42 });
    const { plan } = await buildPlan(host, state, resources);
    await executePlan(plan, { client: host, state, statePath: "s.json", save: noSave, now: () => "t" });

    const rulesetPut = host.calls.find((c) => c.path === "/dynamicgroups/100/ruleset" && c.method === "PUT")!;
    const body = rulesetPut.body as { dynamicGroupRuleSet: { query: { params: { filter: { "==": unknown[] } } } } };
    // The campus ref, pending at plan time, is the freshly-created id (42) in the PUT — not a sentinel.
    expect(body.dynamicGroupRuleSet.query.params.filter["=="][1]).toBe(42);
  });

  it("orders a same-tier pending ref target before its referencer (group → ref.group)", async () => {
    // PR #46 review finding: both groups are tier 1, and the referencer is declared FIRST.
    // Declaration order alone would apply "all_kids" before "b_target" and the pending id could
    // never resolve — the injected dependency edge must put the target first.
    const { resources } = await evaluateConfig((ct) => {
      ct.group({
        key: "all_kids",
        name: "All Kids",
        groupTypeId: 1,
        dynamic: {
          status: "manual",
          ruleset: { query: churchQuery(q.eq("ctgroup.parentId", ref.group("b_target"))) },
        },
      });
      ct.group({ key: "b_target", name: "Target", groupTypeId: 1 });
    });
    const state = emptyState("h");
    state.resources.all_kids = {
      type: "group", id: 100, key: "all_kids", fields: { name: "All Kids", groupTypeId: 1 }, adoptedAt: "t", updatedAt: "t",
    };
    const host = fakeHost({ "/groups/100": { name: "All Kids", groupTypeId: 1 } }, { "POST /groups": 55 });
    const { plan } = await buildPlan(host, state, resources);
    await executePlan(plan, { client: host, state, statePath: "s.json", save: noSave, now: () => "t" });

    const createIdx = host.calls.findIndex((c) => c.method === "POST" && c.path === "/groups");
    const putIdx = host.calls.findIndex((c) => c.method === "PUT" && c.path === "/dynamicgroups/100/ruleset");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(putIdx).toBeGreaterThan(createIdx); // target created before the referencing ruleset writes
    const body = host.calls[putIdx]!.body as { dynamicGroupRuleSet: { query: { params: { filter: { "==": unknown[] } } } } };
    expect(body.dynamicGroupRuleSet.query.params.filter["=="][1]).toBe(55); // the fresh id, not a sentinel
  });
});

describe("permission domainId resolution", () => {
  it("resolves a groupType ref to the domainId and diffs against it", async () => {
    const { permissions } = await evaluateConfig((ct) => {
      ct.groupTypeRole({ key: "tpl", groupType: "ministry_team", grants: ["churchgroup:administer groups"] });
    });
    const client = {
      get: async <T>(path: string): Promise<T> => {
        if (path === "/group/grouptypes") return [{ id: 9, name: "Ministry Team" }] as T;
        if (path === "/permissions/group_type_role") return [] as T;
        throw new CtApiError(`not found: ${path}`, 404, null);
      },
    };
    const { items } = await buildPermissionPlan(client, emptyState("h"), permissions);
    expect(items).toHaveLength(1);
    expect(items[0]?.domainId).toBe(9); // resolved from the catalog, not a raw number
  });

  it("rejects two permissions whose refs resolve to the same domainId (post-resolution guard)", async () => {
    const { permissions } = await evaluateConfig((ct) => {
      ct.groupTypeRole({ key: "a", groupType: "ministry_team", grants: ["churchgroup:administer groups"] });
      ct.groupTypeRole({ key: "b", id: 9, grants: ["churchgroup:administer groups"] });
    });
    const client = {
      get: async <T>(path: string): Promise<T> => {
        if (path === "/group/grouptypes") return [{ id: 9, name: "Ministry Team" }] as T;
        if (path === "/permissions/group_type_role") return [] as T;
        throw new CtApiError(`not found: ${path}`, 404, null);
      },
    };
    await expect(buildPermissionPlan(client, emptyState("h"), permissions)).rejects.toThrow(
      /Duplicate permission target after resolution: group_type_role #9/,
    );
  });

  it("rejects a gated group_role reference at plan time", async () => {
    const { permissions } = await evaluateConfig((ct) => {
      ct.groupRole({ key: "p", group: "kids", role: "Leiter", grants: ["churchgroup:administer groups"] });
    });
    const client = { get: async <T>(): Promise<T> => [] as T };
    await expect(buildPermissionPlan(client, emptyState("h"), permissions)).rejects.toThrow(
      /not yet supported.*pass a numeric id.*#25/,
    );
  });
});

describe("acceptance: one config, two hosts", () => {
  /** The identical config module — no numeric ids anywhere the resolver can fill in per host. */
  const config = (ct: Parameters<Parameters<typeof evaluateConfig>[0]>[0]): void => {
    ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });
    ct.group({ key: "kids", name: "Kids", groupType: "ministry_team", campus: "mainz" });
    ct.groupTypeRole({
      key: "tpl",
      groupType: "ministry_team",
      grants: [{ right: "churchgroup:view group", scope: ["kids"] }],
    });
  };

  async function planFor(groupTypeId: number, state: State) {
    const { resources, permissions } = await evaluateConfig(config);
    const catalogs = {
      "/group/grouptypes": [{ id: groupTypeId, name: "Ministry Team" }],
      "/permissions/group_type_role": [],
    };
    const client = fakeHost(catalogs);
    const resolver = new Resolver({ client, state, desired: resources, host: state.host });
    const { plan } = await buildPlan(client, state, resources, { resolver });
    const { items } = await buildPermissionPlan(client, state, permissions, resources, resolver);
    return { plan, items };
  }

  it("produces valid, host-specific plans against two different catalogs without editing the config", async () => {
    // Host A: group type id 2. Host B: the SAME group type named differently in the catalog → id 77.
    const a = await planFor(2, emptyState("https://a.church.tools"));
    const b = await planFor(77, emptyState("https://b.church.tools"));

    const groupOf = (p: typeof a.plan) => p.items.find((i) => i.key === "kids")!;
    expect(groupOf(a.plan).changes).toContainEqual({ field: "groupTypeId", from: undefined, to: 2 });
    expect(groupOf(b.plan).changes).toContainEqual({ field: "groupTypeId", from: undefined, to: 77 });

    // Permission domainId is resolved per host from the same logical ref.
    expect(a.items[0]?.domainId).toBe(2);
    expect(b.items[0]?.domainId).toBe(77);

    // Both plans create the campus + group (2 creates each) — the config is valid against both hosts.
    expect(a.plan.items.filter((i) => i.action === "create")).toHaveLength(2);
    expect(b.plan.items.filter((i) => i.action === "create")).toHaveLength(2);
  });
});
