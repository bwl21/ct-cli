/**
 * Command-level protected-env guardrail for `ct apply --env` (#22):
 *  - a PROTECTED env refuses to apply on --auto-approve alone (typed confirmation is mandatory);
 *  - --confirm-env <name> that matches substitutes for the typed input (CI path) and applies;
 *  - a mismatched --confirm-env still refuses;
 *  - an UNPROTECTED env applies with --auto-approve as before.
 * Mocks the apply pipeline (session/config/plan/execute/backup) so the real env wiring runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan } from "../src/engine/types.js";

const plan: Plan = {
  items: [
    { type: "campus", key: "mainz", id: null, action: "create", changes: [{ field: "name", from: undefined, to: "Mainz" }] },
  ],
};

const executePlan = vi.fn(async () => ({ created: ["mainz"], updated: [], skippedDeletes: [] }));

vi.mock("../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({ client: { request: vi.fn(), get: vi.fn() }, me: { id: 1 } })),
}));
vi.mock("../src/config/load.js", () => ({
  DEFAULT_CONFIG_PATH: "ct.config.ts",
  resolveConfigPath: (explicit?: string) => explicit ?? "ct.config.ts",
  loadConfig: vi.fn(async () => ({ resources: [], permissions: [], configDir: "." })),
}));
vi.mock("../src/engine/build.js", () => ({
  buildPlan: vi.fn(async () => ({ plan, actual: new Map(), fetchErrors: [] })),
}));
vi.mock("../src/engine/execute.js", () => ({ executePlan }));
vi.mock("../src/permissions/plan.js", () => ({
  buildPermissionPlan: vi.fn(async () => ({ items: [], fetchErrors: [], warnings: [] })),
}));
vi.mock("../src/permissions/apply.js", () => ({
  applyPermissionPlan: vi.fn(async () => ({ granted: 0, deleted: 0, failed: [] })),
}));
vi.mock("../src/engine/backup.js", () => ({ writeBackup: vi.fn(async () => "backup.json") }));

const { applyCommand } = await import("../src/commands/apply.js");
const { saveState, emptyState } = await import("../src/state/state.js");

const DEV = "https://mychurch-dev.church.tools";
const PROD = "https://mychurch.church.tools";
const envsPath = join(tmpdir(), `ct-cli-applyenv-envs-${process.pid}.json`);
const devState = join(tmpdir(), `ct-cli-applyenv-dev-${process.pid}.json`);
const prodState = join(tmpdir(), `ct-cli-applyenv-prod-${process.pid}.json`);
const backupDir = join(tmpdir(), `ct-cli-applyenv-backups-${process.pid}`);

const saved = { host: process.env.CT_HOST, envs: process.env.CT_ENVS };

async function runApply(args: string[]): Promise<void> {
  await applyCommand().parseAsync(["--backup-dir", backupDir, ...args], { from: "user" });
}

beforeEach(async () => {
  executePlan.mockClear();
  delete process.env.CT_HOST;
  process.env.CT_ENVS = envsPath;
  await writeFile(
    envsPath,
    JSON.stringify({
      environments: {
        dev: { host: DEV, state: devState },
        prod: { host: PROD, state: prodState, protected: true },
      },
    }),
    "utf8",
  );
  await saveState(devState, emptyState(DEV));
  await saveState(prodState, emptyState(PROD));
});

afterEach(async () => {
  process.exitCode = 0;
  if (saved.host === undefined) delete process.env.CT_HOST;
  else process.env.CT_HOST = saved.host;
  if (saved.envs === undefined) delete process.env.CT_ENVS;
  else process.env.CT_ENVS = saved.envs;
  await rm(envsPath, { force: true });
  await rm(devState, { force: true });
  await rm(prodState, { force: true });
  await rm(backupDir, { recursive: true, force: true });
});

describe("ct apply --env protected guardrail", () => {
  it("refuses a protected env on --auto-approve alone (no --confirm-env, non-TTY)", async () => {
    await runApply(["--env", "prod", "--auto-approve"]);
    expect(executePlan).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("applies a protected env when --confirm-env matches the env name", async () => {
    await runApply(["--env", "prod", "--auto-approve", "--confirm-env", "prod"]);
    expect(executePlan).toHaveBeenCalledTimes(1);
  });

  it("refuses when --confirm-env does not match the env name", async () => {
    await runApply(["--env", "prod", "--auto-approve", "--confirm-env", "dev"]);
    expect(executePlan).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("applies an UNPROTECTED env with --auto-approve as before (no --confirm-env needed)", async () => {
    await runApply(["--env", "dev", "--auto-approve"]);
    expect(executePlan).toHaveBeenCalledTimes(1);
  });
});
