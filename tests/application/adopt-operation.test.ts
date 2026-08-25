import { describe, expect, it, vi } from "vitest";
import { runAdoptResource, type AdoptOperationDependencies } from "../../src/application/operations/adopt.js";
import { emptyState } from "../../src/state/state.js";

const host = "https://example.church.tools";

describe("runAdoptResource", () => {
  it("returns a portable proposal and owns the state write", async () => {
    const state = emptyState(host);
    const saveState = vi.fn();
    const client = { get: vi.fn(async () => ({ id: 0, name: "Mainz", shorty: "MZ" })) };
    const dependencies: AdoptOperationDependencies = {
      resolveProject: vi.fn(async () => ({
        cwd: "/project",
        configPath: "/project/ct.config.ts",
        statePath: "/project/state.json",
        environmentsPath: "/project/ct.envs.json",
        configDisplayPath: "ct.config.ts",
        stateDisplayPath: "state.json",
        environment: "dev",
        protected: false,
        host,
      })),
      loadState: vi.fn(async () => state),
      saveState,
      authedSession: vi.fn(async () => ({
        client,
        me: { id: 1 },
      })) as unknown as AdoptOperationDependencies["authedSession"],
      createReverseResolver: () => ({
        sugarFields: vi.fn(async (fields) => ({ fields, todos: new Set<string>() })),
      }),
      clock: { now: () => new Date("2026-08-25T20:00:00.000Z") },
    };

    const result = await runAdoptResource({ type: "campus", id: "0" }, dependencies);
    expect(result).toMatchObject({
      operation: "adopt",
      value: { type: "campus", id: 0, key: "mainz", action: "created", dryRun: false },
    });
    expect(result.value.config).toContain('key: "mainz"');
    expect(saveState).toHaveBeenCalledOnce();
    expect(state.resources.mainz).toMatchObject({ id: 0, adoptedAt: "2026-08-25T20:00:00.000Z" });
  });

  it("rejects an invalid id before project or network resolution", async () => {
    const resolveProject = vi.fn();
    await expect(runAdoptResource({ type: "campus", id: "3abc" }, { resolveProject })).rejects.toThrow(
      /expected a non-negative integer/,
    );
    expect(resolveProject).not.toHaveBeenCalled();
  });
});
