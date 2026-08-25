import { describe, expect, it, vi } from "vitest";
import type { CtApplicationError } from "../../src/application/errors.js";
import {
  executePreparedDestroy,
  prepareDestroy,
  type DestroyOperationDependencies,
  type PreparedDestroyExecution,
} from "../../src/application/operations/destroy.js";
import { PreparedOperationStore } from "../../src/application/prepared-operation-store.js";
import type { CtClient } from "../../src/api/ctClient.js";
import { emptyState } from "../../src/state/state.js";

const host = "https://example.church.tools";
const statePath = "/project/ct-state.prod.json";

function harness() {
  let stateFile = "state-v1";
  const state = emptyState(host);
  state.resources.area = {
    type: "group",
    id: 42,
    key: "area",
    fields: {},
    adoptedAt: "t",
    updatedAt: "t",
  };
  const request = vi.fn(async () => ({}));
  const client = {
    get: vi.fn(async () => []),
    request,
  } as unknown as CtClient;
  const store = new PreparedOperationStore<PreparedDestroyExecution>(undefined, {
    nextId: () => "destroy-1",
  });
  const events: string[] = [];
  const dependencies: DestroyOperationDependencies = {
    store,
    readStateFile: async () => stateFile,
    resolveProject: vi.fn(async () => ({
      cwd: "/project",
      configPath: "/project/ct.config.ts",
      statePath,
      environmentsPath: "/project/ct.envs.json",
      configDisplayPath: "ct.config.ts",
      stateDisplayPath: "ct-state.prod.json",
      environment: "prod",
      protected: true,
      host,
    })),
    loadState: vi.fn(async () => state),
    authedSession: vi.fn(async () => ({ client, me: { id: 1 } })),
    fetchActual: vi.fn(async () => ({
      actual: new Map([["area", { name: "Area" }]]),
      fetchErrors: [],
      unresolved: new Set<string>(),
      fetchFailed: new Map<string, string>(),
    })),
    writeBackup: vi.fn(async () => "/project/backups/backup.json"),
    saveState: vi.fn(async () => {}),
    observer: { emit: (event) => events.push(event.type) },
  };
  return {
    dependencies,
    request,
    events,
    changeState(value: string) {
      stateFile = value;
    },
  };
}

async function expectCode(promise: Promise<unknown>, code: CtApplicationError["code"]): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "CtApplicationError", code });
}

describe("prepared destroy operation", () => {
  it("exposes the exact proposal and requires the protected environment before deleting", async () => {
    const test = harness();
    const prepared = await prepareDestroy({ targets: ["area"] }, test.dependencies);

    expect(prepared).toMatchObject({
      id: "destroy-1",
      targets: ["area"],
      memberFields: [],
      backupPath: "/project/backups/backup.json",
      confirmation: { type: "environment", environment: "prod" },
    });
    expect(test.request).not.toHaveBeenCalled();

    await expectCode(
      executePreparedDestroy(prepared, { type: "yes" }, test.dependencies),
      "PROTECTED_ENV_CONFIRMATION_REQUIRED",
    );
    expect(test.request).not.toHaveBeenCalled();

    const result = await executePreparedDestroy(
      prepared,
      { type: "environment", value: "prod" },
      test.dependencies,
    );
    expect(test.request).toHaveBeenCalledWith("DELETE", "/groups/42");
    expect(result).toMatchObject({
      operation: "destroy",
      value: {
        backupPath: "/project/backups/backup.json",
        complete: true,
        outcomes: [{ key: "area", id: 42, status: "destroyed" }],
      },
    });
    expect(test.events).toContain("resource-destroyed");
  });

  it("refuses a proposal after its state file changed", async () => {
    const test = harness();
    const prepared = await prepareDestroy({ targets: ["area"] }, test.dependencies);
    test.changeState("state-v2");

    await expectCode(
      executePreparedDestroy(prepared, { type: "environment", value: "prod" }, test.dependencies),
      "PLAN_CONFIRMATION_MISMATCH",
    );
    expect(test.request).not.toHaveBeenCalled();
  });
});
