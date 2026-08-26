import { describe, expect, it, vi } from "vitest";
import { runRefresh, type RefreshOperationDependencies } from "../../src/application/operations/refresh.js";
import type { ManagedResource } from "../../src/state/state.js";

const host = "https://example.church.tools";
const targets: ManagedResource[] = [
  { type: "group", id: 10, key: "a", fields: {}, adoptedAt: "t", updatedAt: "t" },
  { type: "group", id: 11, key: "b", fields: {}, adoptedAt: "t", updatedAt: "t" },
];

function dependencies(): RefreshOperationDependencies {
  const request = vi
    .fn()
    .mockResolvedValueOnce([{ created: 2, updated: 1, deleted: 0 }])
    .mockRejectedValueOnce(new Error("boom"));
  return {
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
    loadState: vi.fn(async () => ({ version: 1 as const, host, resources: {} })),
    authedSession: vi.fn(async () => ({
      client: { request },
      me: { id: 1 },
    })) as unknown as RefreshOperationDependencies["authedSession"],
    selectTargets: vi.fn(async () => targets),
  };
}

describe("runRefresh", () => {
  it("keeps per-target success and failure structured while continuing the fan-out", async () => {
    const result = await runRefresh({ all: true }, dependencies());
    expect(result.warnings).toEqual([
      {
        code: "REFRESH_FAN_OUT",
        message: "Refreshing 2 managed dynamic group(s) — this recomputes membership.",
      },
    ]);
    expect(result.value).toMatchObject({
      failed: 1,
      fanOut: true,
      outcomes: [
        { key: "a", counts: { created: 2, updated: 1, deleted: 0 }, error: null },
        { key: "b", counts: null, error: "boom" },
      ],
    });
  });

  it("cautions about the fan-out BEFORE any membership is recomputed", async () => {
    const seen: string[] = [];
    const deps = dependencies();
    const authed = deps.authedSession!;
    await runRefresh(
      { all: true },
      {
        ...deps,
        authedSession: (async () => {
          const session = await authed();
          const inner = session.client.request;
          return {
            ...session,
            client: {
              ...session.client,
              request: (...args: Parameters<typeof inner>) => {
                seen.push("post");
                return inner(...args);
              },
            },
          };
        }) as typeof authed,
        observer: {
          emit: (event) => {
            if (event.type === "warning") seen.push(`warning:${event.warning.code}`);
            if (event.type === "outcome") seen.push(`outcome:${event.outcome.status}`);
          },
        },
      },
    );
    expect(seen).toEqual(["warning:REFRESH_FAN_OUT", "post", "outcome:ok", "post", "outcome:failed"]);
  });

  it("requires an explicit single target or fan-out intent", async () => {
    await expect(runRefresh({}, dependencies())).rejects.toThrow(/Specify --group <key>.*--all/);
  });
});
