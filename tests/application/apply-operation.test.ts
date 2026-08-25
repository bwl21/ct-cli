import { describe, expect, it, vi } from "vitest";
import type { CtApplicationError } from "../../src/application/errors.js";
import {
  executePreparedApply,
  prepareApply,
  type ApplyOperationDependencies,
  type PreparedApplyExecution,
} from "../../src/application/operations/apply.js";
import { PreparedOperationStore } from "../../src/application/prepared-operation-store.js";
import type { Clock } from "../../src/application/ports.js";
import type { Plan } from "../../src/engine/types.js";
import { emptyState } from "../../src/state/state.js";

const host = "https://example.church.tools";
const statePath = "/project/ct-state.prod.json";
const resourcePlan: Plan = {
  items: [
    {
      type: "campus",
      key: "mainz",
      id: null,
      action: "create",
      changes: [{ field: "name", from: undefined, to: "Mainz" }],
    },
  ],
};

function harness(options: { protected?: boolean; environment?: string | null } = {}) {
  let now = new Date("2026-08-25T20:00:00.000Z");
  let stateFile = "state-v1";
  const clock: Clock = { now: () => now };
  const store = new PreparedOperationStore<PreparedApplyExecution>(clock, {
    nextId: () => "prepared-1",
  });
  const order: string[] = [];
  const execute = vi.fn(async () => {
    order.push("execute");
    return { created: ["mainz"], updated: [], skippedDeletes: [] };
  });
  const backup = vi.fn(async () => {
    order.push("backup");
    return "/project/backups/backup.json";
  });
  const client = { version: "3.140.0", get: vi.fn(), request: vi.fn() };
  const dependencies: ApplyOperationDependencies = {
    clock,
    store,
    readStateFile: async () => stateFile,
    resolveProject: vi.fn(async () => ({
      cwd: "/project",
      configPath: "/project/ct.config.ts",
      statePath,
      environmentsPath: "/project/ct.envs.json",
      configDisplayPath: "ct.config.ts",
      stateDisplayPath: "ct-state.prod.json",
      environment: options.environment === undefined ? "prod" : options.environment,
      protected: options.protected ?? true,
      host,
    })),
    loadHostCatalog: vi.fn(async () => null),
    loadConfig: vi.fn(async () => ({ resources: [], permissions: [], configDir: "/project" })),
    loadState: vi.fn(async () => emptyState(host)),
    authedSession: vi.fn(async () => ({
      client,
      me: { id: 1 },
    })) as unknown as ApplyOperationDependencies["authedSession"],
    buildPlan: vi.fn(async () => ({
      plan: resourcePlan,
      actual: new Map([["existing", { name: "Existing" }]]),
      fetchErrors: [],
    })),
    buildPermissionPlan: vi.fn(async () => ({ items: [], fetchErrors: [], warnings: [] })),
    writeBackup: backup,
    executePlan: execute,
    applyPermissionPlan: vi.fn(async () => ({ granted: 0, deleted: 0, failed: [] })),
  };
  return {
    dependencies,
    execute,
    backup,
    order,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    changeState(value: string) {
      stateFile = value;
    },
  };
}

async function expectCode(promise: Promise<unknown>, code: CtApplicationError["code"]): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "CtApplicationError", code });
}

describe("prepared apply operation", () => {
  it("requires the exact protected environment and writes the backup before resources", async () => {
    const test = harness();
    const prepared = await prepareApply({}, test.dependencies);

    expect(prepared).toMatchObject({
      id: "prepared-1",
      changeCount: 1,
      confirmation: { type: "environment", environment: "prod" },
    });
    await expectCode(
      executePreparedApply(prepared, { type: "yes" }, test.dependencies),
      "PROTECTED_ENV_CONFIRMATION_REQUIRED",
    );
    expect(test.execute).not.toHaveBeenCalled();

    const result = await executePreparedApply(
      prepared,
      { type: "environment", value: "prod" },
      test.dependencies,
    );
    expect(test.order).toEqual(["backup", "execute"]);
    expect(result).toMatchObject({
      operation: "apply",
      value: {
        backupPath: "/project/backups/backup.json",
        resources: { created: ["mainz"] },
      },
    });
  });

  it("refuses an expired prepared operation before backup or mutation", async () => {
    const test = harness();
    const prepared = await prepareApply({}, { ...test.dependencies, preparedTtlMs: 100 });
    test.advance(100);

    await expectCode(
      executePreparedApply(prepared, { type: "environment", value: "prod" }, test.dependencies),
      "OPERATION_EXPIRED",
    );
    expect(test.backup).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
  });

  it("is single-use", async () => {
    const test = harness({ protected: false, environment: "dev" });
    const prepared = await prepareApply({}, test.dependencies);
    await executePreparedApply(prepared, { type: "yes" }, test.dependencies);

    await expectCode(
      executePreparedApply(prepared, { type: "yes" }, test.dependencies),
      "OPERATION_ALREADY_USED",
    );
    expect(test.execute).toHaveBeenCalledTimes(1);
  });

  it("refuses when the state file changed after prepare", async () => {
    const test = harness({ protected: false, environment: "dev" });
    const prepared = await prepareApply({}, test.dependencies);
    test.changeState("state-v2");

    await expectCode(
      executePreparedApply(prepared, { type: "yes" }, test.dependencies),
      "PLAN_CONFIRMATION_MISMATCH",
    );
    expect(test.backup).not.toHaveBeenCalled();
    expect(test.execute).not.toHaveBeenCalled();
  });
});
