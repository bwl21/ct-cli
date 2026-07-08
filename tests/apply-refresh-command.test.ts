/**
 * Command-level gating for `ct apply --refresh`: mocks the whole apply
 * pipeline (session, buildPlan, executePlan, loadConfig) so we can prove the
 * `--refresh` flag is what decides whether the per-group refresh runs — not
 * just that the extracted helper (tests/apply-refresh.test.ts) is correct in
 * isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan } from "../src/engine/types.js";

interface Call {
  method: string;
  path: string;
}

const calls: Call[] = [];
const requestMock = vi.fn(async (method: string, path: string) => {
  calls.push({ method, path });
  if (path === "/dynamicgroups/42/refresh") {
    return [{ created: 1, updated: 2, deleted: 0 }];
  }
  return {};
});

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

vi.mock("../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({ client: { request: requestMock }, me: { id: 1 } })),
}));

vi.mock("../src/config/load.js", () => ({
  DEFAULT_CONFIG_PATH: "ct.config.ts",
  resolveConfigPath: (explicit?: string) => explicit ?? "ct.config.ts",
  loadConfig: vi.fn(async () => ({ resources: [], permissions: [] })),
}));

vi.mock("../src/engine/build.js", () => ({
  buildPlan: vi.fn(async () => ({ plan, actual: new Map(), fetchErrors: [] })),
}));

vi.mock("../src/engine/execute.js", () => ({
  executePlan: vi.fn(async () => ({ created: [], updated: ["dyn_a"], skippedDeletes: [] })),
}));

vi.mock("../src/engine/backup.js", () => ({
  writeBackup: vi.fn(async () => "backup.json"),
}));

const { applyCommand } = await import("../src/commands/apply.js");
const { loadState, saveState, emptyState } = await import("../src/state/state.js");

const statePath = join(tmpdir(), `ct-cli-apply-refresh-${process.pid}.json`);
const HOST = "https://eqrm.church.tools";

async function runApply(args: string[]): Promise<void> {
  await applyCommand().parseAsync(args, { from: "user" });
}

const originalHost = process.env.CT_HOST;

beforeEach(async () => {
  calls.length = 0;
  requestMock.mockClear();
  process.env.CT_HOST = HOST;
  const state = emptyState(HOST);
  state.resources.dyn_a = {
    type: "group",
    id: 42,
    key: "dyn_a",
    fields: {},
    adoptedAt: "t",
    updatedAt: "t",
  };
  await saveState(statePath, state);
});

afterEach(async () => {
  if (originalHost === undefined) {
    delete process.env.CT_HOST;
  } else {
    process.env.CT_HOST = originalHost;
  }
  await rm(statePath, { force: true });
});

describe("ct apply --refresh (command-level gating)", () => {
  it("with --refresh: POSTs /dynamicgroups/{id}/refresh once for the changed dynamic group", async () => {
    await runApply(["--state", statePath, "--auto-approve", "--refresh"]);
    const refreshCalls = calls.filter((c) => c.path.startsWith("/dynamicgroups/"));
    expect(refreshCalls).toEqual([{ method: "POST", path: "/dynamicgroups/42/refresh" }]);
    const state = await loadState(statePath, HOST);
    expect(state.resources.dyn_a?.id).toBe(42);
  });

  it("never calls the all-groups /dynamicgroups/refresh endpoint", async () => {
    await runApply(["--state", statePath, "--auto-approve", "--refresh"]);
    expect(calls.some((c) => c.path === "/dynamicgroups/refresh")).toBe(false);
  });

  it("without --refresh: no dynamicgroups refresh call at all", async () => {
    await runApply(["--state", statePath, "--auto-approve"]);
    expect(calls.some((c) => c.path.startsWith("/dynamicgroups/"))).toBe(false);
  });
});
