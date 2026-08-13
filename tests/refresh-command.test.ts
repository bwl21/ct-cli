/**
 * `ct refresh` (#105).
 *
 * `ct apply` writes the ruleset and flips the status; ChurchTools materializes membership on its own
 * schedule — so a freshly created auto-group is legitimately empty after a green apply. `--refresh`
 * only covers groups CHANGED in that run, so it cannot re-evaluate an existing group and does nothing
 * on a no-op plan. These tests pin the lever that closes that gap, and the guardrails on it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "../src/state/state.js";

const requestMock = vi.fn(async (...args: [string, string]) => {
  void args;
  return [{ created: 3, updated: 1, deleted: 0 }];
});
const getAllMock = vi.fn(async () => ({ data: [{ id: 10 }, { id: 12 }] }));

vi.mock("../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({ client: { request: requestMock, getAll: getAllMock }, me: { id: 1 } })),
}));

const { refreshCommand } = await import("../src/commands/refresh.js");

const HOST = "https://mychurch.church.tools";
const originalHost = process.env.CT_HOST;
let workDir: string;
let statePath: string;

const state: State = {
  version: 1,
  host: HOST,
  resources: {
    auto_a: { type: "group", id: 10, key: "auto_a", fields: {}, adoptedAt: "t", updatedAt: "t" },
    auto_b: { type: "group", id: 12, key: "auto_b", fields: {}, adoptedAt: "t", updatedAt: "t" },
    plain_c: { type: "group", id: 13, key: "plain_c", fields: {}, adoptedAt: "t", updatedAt: "t" },
    a_campus: { type: "campus", id: 0, key: "a_campus", fields: {}, adoptedAt: "t", updatedAt: "t" },
  },
};

async function run(args: string[]): Promise<void> {
  await refreshCommand().parseAsync([...args, "--state", statePath], { from: "user" });
}

beforeEach(() => {
  requestMock.mockClear();
  getAllMock.mockClear();
  process.env.CT_HOST = HOST;
  workDir = mkdtempSync(join(tmpdir(), "ct-refresh-"));
  statePath = join(workDir, "ct-state.json");
  writeFileSync(statePath, JSON.stringify(state), "utf8");
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHost === undefined) delete process.env.CT_HOST;
  else process.env.CT_HOST = originalHost;
  rmSync(workDir, { recursive: true, force: true });
  process.exitCode = 0;
});

describe("ct refresh (#105)", () => {
  it("refreshes one named group via the PER-GROUP endpoint", async () => {
    await run(["--group", "auto_a"]);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith("POST", "/dynamicgroups/10/refresh");
  });

  it("never fans out without --all — refreshing recomputes membership", async () => {
    await expect(run([])).rejects.toThrow(/Specify --group <key> for one group, or --all/);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("--all refreshes every MANAGED dynamic group and nothing else", async () => {
    await run(["--all"]);
    expect(requestMock.mock.calls.map((c) => c[1])).toEqual([
      "/dynamicgroups/10/refresh",
      "/dynamicgroups/12/refresh",
    ]);
    // plain_c is managed but not an auto-group; a_campus is not a group at all.
  });

  it("never touches the all-groups endpoint (blast radius) or the legacy scheduler ping", async () => {
    await run(["--all"]);
    const paths = requestMock.mock.calls.map((c) => String(c[1]));
    expect(paths).not.toContain("/dynamicgroups/refresh");
    expect(paths.some((p) => p.includes("cron"))).toBe(false);
  });

  it("refuses a managed group that has no ruleset, instead of POSTing into a 404", async () => {
    await expect(run(["--group", "plain_c"])).rejects.toThrow(/is not a dynamic group on this host/);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("refuses an unmanaged key — ct only ever refreshes what the config owns", async () => {
    await expect(run(["--group", "nope"])).rejects.toThrow(/not a managed group in this state file/);
  });

  it("rejects --group together with --all", async () => {
    await expect(run(["--group", "auto_a", "--all"])).rejects.toThrow(/only one of: --group, --all/);
  });

  it("keeps going after one failure and exits non-zero", async () => {
    requestMock.mockRejectedValueOnce(new Error("boom"));
    await run(["--all"]);
    expect(requestMock).toHaveBeenCalledTimes(2); // the second group still ran
    expect(process.exitCode).toBe(1);
  });
});
