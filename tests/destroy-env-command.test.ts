/**
 * Command-level protected-env guardrail for `ct destroy --env` (#22): --force does
 * NOT bypass a protected env — typed confirmation of the env name is mandatory, and
 * --confirm-env <name> substitutes for it in CI. An unprotected env keeps --force.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const deletes: string[] = [];
const requestMock = vi.fn(async (method: string, path: string) => {
  if (method === "DELETE") deletes.push(path);
  return {};
});
const getMock = vi.fn(async (path: string) => (path === "/groups/hierarchies" ? [] : { name: path }));

vi.mock("../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({ client: { get: getMock, request: requestMock }, me: { id: 1 } })),
}));
vi.mock("../src/engine/backup.js", () => ({ writeBackup: vi.fn(async () => "backup.json") }));

const { destroyCommand } = await import("../src/commands/destroy.js");
const { saveState, loadState, emptyState } = await import("../src/state/state.js");

const PROD = "https://mychurch.church.tools";
const envsPath = join(tmpdir(), `ct-cli-destroyenv-envs-${process.pid}.json`);
const prodState = join(tmpdir(), `ct-cli-destroyenv-prod-${process.pid}.json`);
const backupDir = join(tmpdir(), `ct-cli-destroyenv-backups-${process.pid}`);
const saved = { host: process.env.CT_HOST, envs: process.env.CT_ENVS };

async function seedState(): Promise<void> {
  const state = emptyState(PROD);
  state.resources.area = { type: "group", id: 1, key: "area", fields: {}, adoptedAt: "t", updatedAt: "t" };
  await saveState(prodState, state);
}

async function runDestroy(args: string[]): Promise<void> {
  await destroyCommand().parseAsync(["--backup-dir", backupDir, ...args], { from: "user" });
}

beforeEach(async () => {
  requestMock.mockClear();
  deletes.length = 0;
  getMock.mockClear();
  delete process.env.CT_HOST;
  process.env.CT_ENVS = envsPath;
  await writeFile(
    envsPath,
    JSON.stringify({ environments: { prod: { host: PROD, state: prodState, protected: true } } }),
    "utf8",
  );
  await seedState();
});

afterEach(async () => {
  process.exitCode = 0;
  if (saved.host === undefined) delete process.env.CT_HOST;
  else process.env.CT_HOST = saved.host;
  if (saved.envs === undefined) delete process.env.CT_ENVS;
  else process.env.CT_ENVS = saved.envs;
  await rm(envsPath, { force: true });
  await rm(prodState, { force: true });
  await rm(backupDir, { recursive: true, force: true });
});

describe("ct destroy --env protected guardrail", () => {
  it("refuses a protected env even with --force (no --confirm-env, non-TTY)", async () => {
    await runDestroy(["--env", "prod", "--target", "area", "--force"]);
    expect(requestMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const after = await loadState(prodState, PROD);
    expect(Object.keys(after.resources)).toEqual(["area"]); // nothing deleted
  });

  it("deletes when --confirm-env matches the protected env name", async () => {
    await runDestroy(["--env", "prod", "--target", "area", "--confirm-env", "prod"]);
    expect(deletes).toEqual(["/groups/1"]);
    const after = await loadState(prodState, PROD);
    expect(Object.keys(after.resources)).toEqual([]);
  });

  it("refuses when --confirm-env does not match", async () => {
    await runDestroy(["--env", "prod", "--target", "area", "--confirm-env", "nope"]);
    expect(requestMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
