import { describe, it, expect } from "vitest";
import { Resolver, reresolvePendingValue } from "../src/resolve/resolver.js";
import { ref, isPendingRef } from "../src/resolve/refs.js";
import { CtApiError } from "../src/api/ctClient.js";
import { emptyState, type State } from "../src/state/state.js";
import type { DesiredResource } from "../src/engine/types.js";

/** A fake client returning canned catalogs by path; 404s on a miss. Counts GET calls per path. */
function fakeClient(byPath: Record<string, unknown>) {
  const calls: Record<string, number> = {};
  return {
    calls,
    get: async <T>(path: string): Promise<T> => {
      calls[path] = (calls[path] ?? 0) + 1;
      if (!(path in byPath)) throw new CtApiError(`not found: ${path}`, 404, null);
      return byPath[path] as T;
    },
  };
}

function stateWith(resources: State["resources"]): State {
  return { ...emptyState("https://x.church.tools"), resources };
}

const NO_DESIRED: DesiredResource[] = [];

describe("Resolver.resolve", () => {
  it("resolves a campus from managed state by logical key (before any catalog fetch)", async () => {
    const state = stateWith({
      mainz: { type: "campus", id: 7, key: "mainz", fields: {}, adoptedAt: "t", updatedAt: "t" },
    });
    const client = fakeClient({});
    const r = new Resolver({ client, state, desired: NO_DESIRED });
    expect(await r.resolve(ref.campus("mainz"), "site")).toBe(7);
    expect(client.calls).toEqual({}); // state hit, no /campuses fetch
  });

  it("resolves a campus from the live catalog by slug(name)", async () => {
    const client = fakeClient({ "/campuses": [{ id: 3, name: "Berlin", shorty: "BE" }, { id: 5, name: "Mainz" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    expect(await r.resolve(ref.campus("mainz"), "site")).toBe(5);
  });

  it("resolves a group type from the live catalog", async () => {
    const client = fakeClient({ "/group/grouptypes": [{ id: 2, name: "Ministry Team" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    expect(await r.resolve(ref.groupType("ministry_team"), "site")).toBe(2);
  });

  it("resolves a group status from /group/memberstatus", async () => {
    const client = fakeClient({ "/group/memberstatus": [{ id: 1, name: "Active" }, { id: 2, name: "Candidate" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    expect(await r.resolve(ref.status("candidate"), "site")).toBe(2);
  });

  it("returns a pending marker for a same-run-declared managed target (not yet in state)", async () => {
    const desired: DesiredResource[] = [{ type: "campus", key: "mainz", fields: {}, dependsOn: [] }];
    const client = fakeClient({ "/campuses": [{ id: 99, name: "Mainz" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired });
    const res = await r.resolve(ref.campus("mainz"), "site");
    expect(isPendingRef(res)).toBe(true);
    expect(client.calls).toEqual({}); // desired hit wins over the catalog
  });

  it("throws listing candidates on an ambiguous catalog match", async () => {
    const client = fakeClient({ "/campuses": [{ id: 1, name: "Mainz" }, { id: 2, name: "Mainz" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED, host: "hostA" });
    await expect(r.resolve(ref.campus("mainz"), "group \"g\"")).rejects.toThrow(
      /Ambiguous campus:mainz referenced at group "g" on hostA: 2 live campuss match/,
    );
  });

  it("throws a clear error on an unknown reference (kind + key + site + host)", async () => {
    const client = fakeClient({ "/campuses": [{ id: 1, name: "Berlin" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED, host: "hostB" });
    await expect(r.resolve(ref.campus("mainz"), "group \"g\".campusId")).rejects.toThrow(
      /Cannot resolve campus:mainz referenced at group "g".campusId on hostB/,
    );
  });

  it("resolves a group_role (group, role) pair to the pairing domainId via the group's role list (#25)", async () => {
    const state = stateWith({
      kids: { type: "group", id: 42, key: "kids", fields: {}, adoptedAt: "t", updatedAt: "t" },
    });
    const client = fakeClient({
      "/groups/42/roles": [{ id: 2882, name: "Leiter" }, { id: 2883, name: "Mitglied" }],
    });
    const r = new Resolver({ client, state, desired: NO_DESIRED });
    // slug("Leiter") === "leiter", so either the slug key or the exact name resolves.
    expect(await r.resolve(ref.groupRole("kids", "leiter"), "perm \"p\"")).toBe(2882);
    expect(await r.resolve(ref.groupRole("kids", "Mitglied"), "perm \"p\"")).toBe(2883);
    expect(client.calls["/groups/42/roles"]).toBe(1); // fetched once, cached across both refs
  });

  it("errors clearly when the role name is not on the group's role list", async () => {
    const state = stateWith({
      kids: { type: "group", id: 42, key: "kids", fields: {}, adoptedAt: "t", updatedAt: "t" },
    });
    const client = fakeClient({ "/groups/42/roles": [{ id: 2882, name: "Leiter" }] });
    const r = new Resolver({ client, state, desired: NO_DESIRED, host: "hostA" });
    await expect(r.resolve(ref.groupRole("kids", "Ghost"), "perm \"p\"")).rejects.toThrow(
      /group #42 has no role named "Ghost".*available: "Leiter".*pass a numeric id/is,
    );
  });

  it("errors when a group_role names a group that isn't managed", async () => {
    const client = fakeClient({});
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    await expect(r.resolve(ref.groupRole("ghost", "Leiter"), "perm \"p\"")).rejects.toThrow(
      /no managed group named "ghost".*pass a numeric id/is,
    );
  });

  it("errors when a group_role names a same-run-declared (not-yet-created) group", async () => {
    const desired: DesiredResource[] = [{ type: "group", key: "kids", fields: {}, dependsOn: [] }];
    const client = fakeClient({});
    const r = new Resolver({ client, state: emptyState("h"), desired });
    await expect(r.resolve(ref.groupRole("kids", "Leiter"), "perm \"p\"")).rejects.toThrow(
      /declared in this config but not yet created.*Apply the group first/is,
    );
  });

  it("errors on a group ref with no managed match (groups have no catalog)", async () => {
    const client = fakeClient({});
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    await expect(r.resolve(ref.group("ghost"), "site")).rejects.toThrow(/no managed group named "ghost"/);
  });

  it("falls back to an exact-name secondary match when the slug misses", async () => {
    const client = fakeClient({ "/group/grouptypes": [{ id: 8, name: "K-9" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    // slug("K-9") === "k_9", so ref.groupType("k_9") hits the slug path; "K-9" hits the exact path.
    expect(await r.resolve(ref.groupType("K-9"), "site")).toBe(8);
  });
});

describe("Resolver.resolveValue", () => {
  it("deep-rewrites refs to ids and fetches each catalog at most once", async () => {
    const client = fakeClient({ "/campuses": [{ id: 5, name: "Mainz" }, { id: 6, name: "Berlin" }] });
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    const value = {
      campusId: ref.campus("mainz"),
      query: { or: [{ "==": [{ var: "ctgroup.campusId" }, ref.campus("mainz")] }, { "==": [{ var: "ctgroup.campusId" }, ref.campus("berlin")] }] },
      untouched: 42,
    };
    const out = await r.resolveValue(value, "site");
    expect(out).toEqual({
      campusId: 5,
      query: { or: [{ "==": [{ var: "ctgroup.campusId" }, 5] }, { "==": [{ var: "ctgroup.campusId" }, 6] }] },
      untouched: 42,
    });
    expect(client.calls["/campuses"]).toBe(1); // cached across the two mainz refs + the berlin ref
  });

  it("returns the original reference untouched when there are no refs", async () => {
    const client = fakeClient({});
    const r = new Resolver({ client, state: emptyState("h"), desired: NO_DESIRED });
    const value = { campusId: 4, groupTypeId: 2 };
    expect(await r.resolveValue(value, "site")).toBe(value); // identity — no rebuild, no fetch
    expect(client.calls).toEqual({});
  });
});

describe("reresolvePendingValue", () => {
  it("replaces a pending marker with the id from post-execute state", () => {
    const state = stateWith({
      mainz: { type: "campus", id: 12, key: "mainz", fields: {}, adoptedAt: "t", updatedAt: "t" },
    });
    const body = { name: "G", campusId: { __pendingRef: ref.campus("mainz") } };
    expect(reresolvePendingValue(body, state)).toEqual({ name: "G", campusId: 12 });
  });

  it("throws if a pending target never landed in state", () => {
    const body = { campusId: { __pendingRef: ref.campus("mainz") } };
    expect(() => reresolvePendingValue(body, emptyState("h"))).toThrow(/did not resolve after apply/);
  });

  it("passes non-pending values through untouched", () => {
    expect(reresolvePendingValue({ campusId: 4, n: [1, 2] }, emptyState("h"))).toEqual({ campusId: 4, n: [1, 2] });
  });
});
