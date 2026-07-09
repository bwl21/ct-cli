import { describe, it, expect } from "vitest";
import { executePlan } from "../src/engine/execute.js";
import { emptyState, type State } from "../src/state/state.js";
import type { Plan } from "../src/engine/types.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function recorder(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const client = {
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      return (responses[key] ?? {}) as T;
    },
  };
  return { client, calls };
}

const noSave: (path: string, state: State) => Promise<void> = async () => {};
const fixedNow = () => "2026-07-07T00:00:00.000Z";

describe("executePlan", () => {
  it("creates a resource, captures its id, and records it in state", async () => {
    const state = emptyState("h");
    const { client, calls } = recorder({ "POST /campuses": { id: 5 } });
    const plan: Plan = {
      items: [
        {
          type: "campus",
          key: "zurich",
          id: null,
          action: "create",
          changes: [
            { field: "name", from: undefined, to: "Zürich" },
            { field: "shortName", from: undefined, to: "ZH" },
          ],
        },
      ],
    };
    const result = await executePlan(plan, {
      client,
      state,
      statePath: "s.json",
      save: noSave,
      now: fixedNow,
    });
    expect(result.created).toEqual(["zurich"]);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/campuses",
      body: { name: "Zürich", shortName: "ZH" },
    });
    expect(state.resources.zurich).toMatchObject({
      type: "campus",
      id: 5,
      key: "zurich",
      fields: { name: "Zürich", shortName: "ZH" },
    });
  });

  it("recreates a vanished resource: the new id takes over the key instead of colliding on the stale entry", async () => {
    // Resource deleted out-of-band in CT but still in state → computePlan emits a create item
    // while the stale entry (old id 5) is still under this key. The create must replace it.
    const state = emptyState("h");
    state.resources.zurich = {
      type: "campus",
      id: 5,
      key: "zurich",
      fields: { name: "Zürich", shorty: "ZH" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const { client } = recorder({ "POST /campuses": { id: 8 } });
    const plan: Plan = {
      items: [
        {
          type: "campus",
          key: "zurich",
          id: null,
          action: "create",
          changes: [
            { field: "name", from: undefined, to: "Zürich" },
            { field: "shorty", from: undefined, to: "ZH" },
          ],
        },
      ],
    };
    const result = await executePlan(plan, {
      client,
      state,
      statePath: "s.json",
      save: noSave,
      now: fixedNow,
    });
    expect(result.failed).toBeUndefined();
    expect(result.created).toEqual(["zurich"]);
    expect(state.resources.zurich).toMatchObject({ id: 8, key: "zurich" });
  });

  it("updates a group via PATCH with only the changed field (siblings left alone)", async () => {
    const state = emptyState("h");
    state.resources.team = {
      type: "group",
      id: 9,
      key: "team",
      fields: { name: "Team", groupTypeId: 2, groupStatusId: 1 },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const { client, calls } = recorder();
    const plan: Plan = {
      items: [
        {
          type: "group",
          key: "team",
          id: 9,
          action: "update",
          changes: [{ field: "name", from: "Team", to: "Team A" }],
          actual: { name: "Team", groupTypeId: 2, groupStatusId: 1 },
        },
      ],
    };
    const result = await executePlan(plan, {
      client,
      state,
      statePath: "s.json",
      save: noSave,
      now: fixedNow,
    });
    expect(result.updated).toEqual(["team"]);
    // PATCH carries ONLY the planned change — CT keeps the untouched siblings.
    expect(calls[0]).toEqual({
      method: "PATCH",
      path: "/groups/9",
      body: { name: "Team A" },
    });
    // Post-apply state reflects what CT now holds: actual ∪ changes.
    expect(state.resources.team!.fields).toEqual({ name: "Team A", groupTypeId: 2, groupStatusId: 1 });
  });

  it("does NOT revert a field that drifted in CT when a sibling field is updated (#27)", async () => {
    // Campus adopted with { name, shorty }; an admin edited `shorty` in the CT UI after adoption,
    // so state carries the adopt-time "MZ" while the fetched actual is "MZX". The user changed `name`.
    const state = emptyState("h");
    state.resources.mainz = {
      type: "campus",
      id: 0,
      key: "mainz",
      fields: { name: "Mainz", shorty: "MZ" }, // stale adopt-time snapshot
      adoptedAt: "t",
      updatedAt: "t",
    };
    const { client, calls } = recorder();
    const plan: Plan = {
      items: [
        {
          type: "campus",
          key: "mainz",
          id: 0,
          action: "update",
          changes: [{ field: "name", from: "Mainz", to: "Mainz HQ" }],
          actual: { name: "Mainz", shorty: "MZX" }, // shorty drifted in CT
        },
      ],
    };
    await executePlan(plan, { client, state, statePath: "s.json", save: noSave, now: fixedNow });
    // PUT replaces the whole object, so it must carry the drifted actual `shorty`, never the stale "MZ".
    expect(calls[0]).toEqual({
      method: "PUT",
      path: "/campuses/0",
      body: { name: "Mainz HQ", shorty: "MZX" },
    });
    // Post-apply state reflects the written body, not the stale snapshot.
    expect(state.resources.mainz!.fields).toEqual({ name: "Mainz HQ", shorty: "MZX" });
  });

  it("reconciles hierarchy edges via PUT/DELETE and never stores parents in state", async () => {
    const state = emptyState("h");
    state.resources.parent = {
      type: "group",
      id: 1,
      key: "parent",
      fields: { name: "P" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    state.resources.child = {
      type: "group",
      id: 2,
      key: "child",
      fields: { name: "C" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const { client, calls } = recorder();
    const plan: Plan = {
      items: [
        {
          type: "group",
          key: "child",
          id: 2,
          action: "update",
          changes: [{ field: "parents", from: [], to: ["parent"] }],
        },
      ],
    };
    await executePlan(plan, { client, state, statePath: "s.json", save: noSave, now: fixedNow });
    expect(calls).toEqual([{ method: "PUT", path: "/groups/2/parents/1", body: undefined }]);
    expect(state.resources.child!.fields.parents).toBeUndefined();
  });

  it("writes hierarchy edges on a first apply (creates carry a parents change) (#28)", async () => {
    // Fresh state: parent + child both created in dependency order, and the child's create carries
    // a `parents` change so the edge is written on the very first apply.
    const state = emptyState("h");
    const { client, calls } = recorder({ "POST /groups": { id: 0 } });
    // Return distinct ids for the two POSTs so resolveId can find the parent.
    let nextId = 1;
    client.request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/groups") return { id: nextId++ } as T;
      return {} as T;
    };
    const plan: Plan = {
      items: [
        {
          type: "group",
          key: "parent",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "parent" }],
        },
        {
          type: "group",
          key: "child",
          id: null,
          action: "create",
          changes: [
            { field: "name", from: undefined, to: "child" },
            { field: "parents", from: undefined, to: ["parent"] },
          ],
        },
      ],
    };
    const result = await executePlan(plan, { client, state, statePath: "s.json", save: noSave, now: fixedNow });
    expect(result.failed).toBeUndefined();
    expect(result.created).toEqual(["parent", "child"]);
    // The edge PUT resolves the parent's freshly-assigned id (1) against the child's (2).
    expect(calls).toContainEqual({ method: "PUT", path: "/groups/2/parents/1", body: undefined });
  });

  it("skips deletes (apply never deletes)", async () => {
    const state = emptyState("h");
    state.resources.old = {
      type: "campus",
      id: 3,
      key: "old",
      fields: {},
      adoptedAt: "t",
      updatedAt: "t",
    };
    const { client, calls } = recorder();
    const plan: Plan = { items: [{ type: "campus", key: "old", id: 3, action: "delete", changes: [] }] };
    const result = await executePlan(plan, {
      client,
      state,
      statePath: "s.json",
      save: noSave,
      now: fixedNow,
    });
    expect(result.skippedDeletes).toEqual(["old"]);
    expect(calls).toEqual([]);
    expect(state.resources.old).toBeDefined();
  });

  it("stops on the first write error and reports it", async () => {
    const state = emptyState("h");
    const client = {
      request: async <T>(): Promise<T> => {
        throw new Error("boom");
      },
    };
    const plan: Plan = {
      items: [
        {
          type: "campus",
          key: "zurich",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "Z" }],
        },
      ],
    };
    const result = await executePlan(plan, {
      client,
      state,
      statePath: "s.json",
      save: noSave,
      now: fixedNow,
    });
    expect(result.failed).toEqual({ key: "zurich", message: "boom" });
    expect(result.created).toEqual([]);
  });
});
