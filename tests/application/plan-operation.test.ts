import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan } from "../../src/engine/types.js";
import type { PermissionPlanItem } from "../../src/permissions/plan.js";

const resourcePlan: Plan = {
  items: [
    {
      type: "campus",
      key: "mainz",
      id: 0,
      action: "update",
      changes: [{ field: "name", from: "MZ", to: "Mainz", source: "config" }],
    },
  ],
};

const permissionItems: PermissionPlanItem[] = [
  {
    key: "team",
    domainType: "group_role",
    domainId: 7,
    diff: {
      toPut: [{ authId: 5, dataId: [], type: "grant" }],
      toDelete: [],
      preserved: [],
      preservedUnknown: [],
    },
  },
];

vi.mock("../../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({
    client: { get: vi.fn(), version: "3.140.0" },
    me: { id: 1 },
  })),
}));

vi.mock("../../src/config/load.js", () => ({
  DEFAULT_CONFIG_PATH: "ct.config.ts",
  resolveConfigPath: (explicit?: string) => explicit ?? "ct.config.ts",
  loadConfig: vi.fn(async () => ({ resources: [], permissions: [], configDir: "." })),
}));

vi.mock("../../src/engine/build.js", () => ({
  buildPlan: vi.fn(async () => ({ plan: resourcePlan, actual: new Map(), fetchErrors: [] })),
}));

vi.mock("../../src/permissions/plan.js", () => ({
  buildPermissionPlan: vi.fn(async () => ({
    items: permissionItems,
    fetchErrors: [],
    warnings: ["catalog warning"],
  })),
}));

const { runPlan } = await import("../../src/application/operations/plan.js");
const { planCommand } = await import("../../src/commands/plan.js");
const { emptyState, saveState } = await import("../../src/state/state.js");

const host = "https://mychurch.church.tools";
const statePath = join(tmpdir(), `ct-plan-operation-${process.pid}.json`);
const savedHost = process.env.CT_HOST;
let stdout = "";
let stdoutSpy: { mockRestore: () => void };

beforeEach(async () => {
  process.env.CT_HOST = host;
  process.exitCode = 0;
  await saveState(statePath, emptyState(host));
  stdout = "";
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as (typeof process.stdout)["write"]);
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  process.exitCode = 0;
  if (savedHost === undefined) delete process.env.CT_HOST;
  else process.env.CT_HOST = savedHost;
  await rm(statePath, { force: true });
});

describe("runPlan", () => {
  it("is the canonical result projected unchanged by the CLI JSON adapter", async () => {
    const events: string[] = [];
    const direct = await runPlan(
      { statePath },
      {
        observer: { emit: (event) => events.push(event.type === "phase-started" ? event.phase : event.type) },
      },
    );

    await planCommand().parseAsync(["--state", statePath, "--json"], { from: "user" });
    const cli = JSON.parse(stdout) as unknown;

    expect(cli).toEqual({
      plan: direct.value.plan,
      permissions: direct.value.permissions,
      summary: direct.value.summary,
    });
    expect(direct).toMatchObject({
      operation: "plan",
      project: { host, statePath },
      warnings: [{ code: "PERMISSION_CATALOG", message: "catalog warning" }],
      value: { complete: true, churchToolsVersion: "3.140.0", stateHost: host },
    });
    expect(events).toEqual(["resolve-project", "load-project", "build-plan"]);
  });
});
