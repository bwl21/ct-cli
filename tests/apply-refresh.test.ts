import { describe, it, expect } from "vitest";
// The dynamic-group refresh is a `postApply` hook on the `dynamic` synthetic field now, driven
// generically by `runPostApplyHooks` — the command layer no longer hardcodes the field/sentinel.
import { runPostApplyHooks } from "../src/engine/synthetic.js";
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

function stateWith(entries: Record<string, number>): State {
  const state = emptyState("h");
  for (const [key, id] of Object.entries(entries)) {
    state.resources[key] = {
      type: "group",
      id,
      key,
      fields: {},
      adoptedAt: "t",
      updatedAt: "t",
    };
  }
  return state;
}

describe("runPostApplyHooks (dynamic refresh)", () => {
  it("POSTs /dynamicgroups/{id}/refresh once for each item whose changes include a dynamic field", async () => {
    const state = stateWith({ dyn_a: 42, dyn_b: 43, plain: 44 });
    const plan: Plan = {
      items: [
        {
          type: "group",
          key: "dyn_a",
          id: 42,
          action: "update",
          changes: [{ field: "dynamic", from: undefined, to: { status: "active", ruleset: {} } }],
        },
        {
          type: "group",
          key: "dyn_b",
          id: 43,
          action: "update",
          changes: [
            { field: "name", from: "old", to: "new" },
            { field: "dynamic", from: undefined, to: { status: "active", ruleset: {} } },
          ],
        },
        {
          type: "group",
          key: "plain",
          id: 44,
          action: "update",
          changes: [{ field: "name", from: "old", to: "new" }],
        },
        { type: "group", key: "noop", id: 45, action: "no-op", changes: [] },
        { type: "group", key: "gone", id: 46, action: "delete", changes: [] },
      ],
    };
    const { client, calls } = recorder({
      "POST /dynamicgroups/42/refresh": [{ created: 1, updated: 2, deleted: 0 }],
      "POST /dynamicgroups/43/refresh": [{ created: 0, updated: 1, deleted: 1 }],
    });

    await runPostApplyHooks(plan, state, client);

    const refreshCalls = calls.filter((c) => c.path.startsWith("/dynamicgroups/"));
    expect(refreshCalls).toHaveLength(2);
    expect(refreshCalls).toContainEqual({
      method: "POST",
      path: "/dynamicgroups/42/refresh",
      body: undefined,
    });
    expect(refreshCalls).toContainEqual({
      method: "POST",
      path: "/dynamicgroups/43/refresh",
      body: undefined,
    });
  });

  it("never calls the all-groups /dynamicgroups/refresh endpoint", async () => {
    const state = stateWith({ dyn_a: 42 });
    const plan: Plan = {
      items: [
        {
          type: "group",
          key: "dyn_a",
          id: 42,
          action: "update",
          changes: [{ field: "dynamic", from: undefined, to: { status: "active", ruleset: {} } }],
        },
      ],
    };
    const { client, calls } = recorder();
    await runPostApplyHooks(plan, state, client);
    expect(calls.some((c) => c.path === "/dynamicgroups/refresh")).toBe(false);
  });

  it("does nothing when no plan item changes the dynamic field", async () => {
    const state = stateWith({ plain: 44 });
    const plan: Plan = {
      items: [
        {
          type: "group",
          key: "plain",
          id: 44,
          action: "update",
          changes: [{ field: "name", from: "old", to: "new" }],
        },
      ],
    };
    const { client, calls } = recorder();
    await runPostApplyHooks(plan, state, client);
    expect(calls).toHaveLength(0);
  });

  it("skips the refresh POST for a dynamic change that demotes the group to status:none", async () => {
    const state = stateWith({ dyn_a: 42, dyn_b: 43 });
    const plan: Plan = {
      items: [
        {
          type: "group",
          key: "dyn_a",
          id: 42,
          action: "update",
          changes: [
            {
              field: "dynamic",
              from: { status: "active", ruleset: {} },
              to: { status: "none", ruleset: {} },
            },
          ],
        },
        {
          type: "group",
          key: "dyn_b",
          id: 43,
          action: "update",
          changes: [{ field: "dynamic", from: undefined, to: { status: "active", ruleset: {} } }],
        },
      ],
    };
    const { client, calls } = recorder({
      "POST /dynamicgroups/43/refresh": [{ created: 1, updated: 0, deleted: 0 }],
    });
    await runPostApplyHooks(plan, state, client);
    const refreshCalls = calls.filter((c) => c.path.startsWith("/dynamicgroups/"));
    expect(refreshCalls).toEqual([{ method: "POST", path: "/dynamicgroups/43/refresh", body: undefined }]);
  });

  it("one group's refresh POST failing does not prevent the next group's refresh", async () => {
    const state = stateWith({ dyn_a: 42, dyn_b: 43 });
    const plan: Plan = {
      items: [
        {
          type: "group",
          key: "dyn_a",
          id: 42,
          action: "update",
          changes: [{ field: "dynamic", from: undefined, to: { status: "active", ruleset: {} } }],
        },
        {
          type: "group",
          key: "dyn_b",
          id: 43,
          action: "update",
          changes: [{ field: "dynamic", from: undefined, to: { status: "active", ruleset: {} } }],
        },
      ],
    };
    const calls: Call[] = [];
    const client = {
      request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        calls.push({ method, path, body });
        if (path === "/dynamicgroups/42/refresh") throw new Error("boom");
        return [{ created: 1, updated: 0, deleted: 0 }] as T;
      },
    };
    await expect(runPostApplyHooks(plan, state, client)).resolves.toBeUndefined();
    const refreshCalls = calls.filter((c) => c.path.startsWith("/dynamicgroups/"));
    expect(refreshCalls).toHaveLength(2);
    expect(refreshCalls).toContainEqual({
      method: "POST",
      path: "/dynamicgroups/42/refresh",
      body: undefined,
    });
    expect(refreshCalls).toContainEqual({
      method: "POST",
      path: "/dynamicgroups/43/refresh",
      body: undefined,
    });
  });

  it("skips a changed-dynamic item whose id is not yet resolvable in state (explicit undefined check, not truthiness)", async () => {
    // id 0 is a legitimate CT id — make sure it is NOT treated as "missing".
    const state = stateWith({ dyn_zero: 0 });
    const plan: Plan = {
      items: [
        {
          type: "group",
          key: "dyn_zero",
          id: 0,
          action: "update",
          changes: [{ field: "dynamic", from: undefined, to: { status: "active", ruleset: {} } }],
        },
        {
          type: "group",
          key: "not_in_state",
          id: null,
          action: "create",
          changes: [{ field: "dynamic", from: undefined, to: { status: "active", ruleset: {} } }],
        },
      ],
    };
    const { client, calls } = recorder({
      "POST /dynamicgroups/0/refresh": [{ created: 0, updated: 0, deleted: 0 }],
    });
    await runPostApplyHooks(plan, state, client);
    expect(calls).toEqual([{ method: "POST", path: "/dynamicgroups/0/refresh", body: undefined }]);
  });
});
