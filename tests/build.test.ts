import { describe, it, expect } from "vitest";
import { buildPlan } from "../src/engine/build.js";
import { emptyState } from "../src/state/state.js";
import { CtApiError } from "../src/api/ctClient.js";
import type { DesiredResource } from "../src/engine/types.js";

/** A fake client that returns canned bodies by path and throws a 404 CtApiError on a miss. */
function fakeClient(byPath: Record<string, unknown>) {
  return {
    get: async <T>(path: string): Promise<T> => {
      if (!(path in byPath)) {
        throw new CtApiError(`not found: ${path}`, 404, null);
      }
      return byPath[path] as T;
    },
  };
}

describe("buildPlan", () => {
  it("diffs desired against fetched actual and returns an ordered plan", async () => {
    const state = emptyState("https://x.church.tools");
    state.resources.mainz = {
      type: "campus",
      id: 0,
      key: "mainz",
      fields: { name: "Mainz", shorty: "MZ" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const desired: DesiredResource[] = [
      { type: "campus", key: "mainz", fields: { name: "Mainz City", shorty: "MZ" }, dependsOn: [] },
    ];
    const client = fakeClient({ "/campuses/0": { name: "Mainz", shorty: "MZ" } });
    const { plan, actual, fetchErrors } = await buildPlan(client, state, desired);
    expect(fetchErrors).toEqual([]);
    expect(actual.get("mainz")).toEqual({ name: "Mainz", shorty: "MZ" });
    const item = plan.items.find((i) => i.key === "mainz")!;
    expect(item.action).toBe("update");
    expect(item.changes).toEqual([{ field: "name", from: "Mainz", to: "Mainz City", source: "config" }]);
    // The fetched actual is threaded onto the update item so execute builds the body from it (#27).
    expect(item.actual).toEqual({ name: "Mainz", shorty: "MZ" });
  });

  it("renders a transient (non-404) fetch error as fetch-failed, not a recreate (#33)", async () => {
    const state = emptyState("https://x.church.tools");
    state.resources.mainz = {
      type: "campus",
      id: 0,
      key: "mainz",
      fields: { name: "Mainz", shorty: "MZ" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const desired: DesiredResource[] = [
      { type: "campus", key: "mainz", fields: { name: "Mainz", shorty: "MZ" }, dependsOn: [] },
    ];
    const client = {
      get: async <T>(): Promise<T> => {
        throw new CtApiError("boom", 500, null);
      },
    };
    const { plan, fetchErrors } = await buildPlan(client, state, desired);
    expect(fetchErrors.length).toBe(1);
    const item = plan.items.find((i) => i.key === "mainz")!;
    // NOT classified as a create/recreate — a healthy resource must never be advised for recreation.
    expect(item.action).toBe("no-op");
    expect(item.note).toBe("fetch-failed");
    expect(item.detail).toBe("500");
    expect(plan.items.some((i) => i.action === "create")).toBe(false);
  });
});
