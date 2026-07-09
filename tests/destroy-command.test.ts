/**
 * Command-level behaviour for `ct destroy` (#17 items 1–3), mocking only the
 * session + backup so the real command wiring runs:
 *  - preventDestroy is read from STATE, and destroy loads NO config file at all
 *    (no loadConfig mock, no config on disk) — so protection survives dropping a
 *    resource from config, and a config eval error can never block a teardown.
 *  - delete ordering honours the live /groups/hierarchies edges: a child group is
 *    deleted before its parent even when --target lists the parent first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Call {
  method: string;
  path: string;
}

const calls: Call[] = [];
const getMock = vi.fn(async (path: string) => {
  if (path === "/groups/hierarchies") {
    return [
      { groupId: 1, parents: [] },
      { groupId: 2, parents: [1] }, // kids (2) → area (1)
    ];
  }
  return { name: path }; // itemPath backup fetch — any body
});
const requestMock = vi.fn(async (method: string, path: string) => {
  calls.push({ method, path });
  return {};
});

vi.mock("../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({ client: { get: getMock, request: requestMock }, me: { id: 1 } })),
}));

vi.mock("../src/engine/backup.js", () => ({
  writeBackup: vi.fn(async () => "backup.json"),
}));

const { destroyCommand } = await import("../src/commands/destroy.js");
const { saveState, loadState, emptyState } = await import("../src/state/state.js");

const statePath = join(tmpdir(), `ct-cli-destroy-cmd-${process.pid}.json`);
const HOST = "https://eqrm.church.tools";
const originalHost = process.env.CT_HOST;

function group(key: string, id: number, extra: Record<string, unknown> = {}) {
  return { type: "group", id, key, fields: {}, adoptedAt: "t", updatedAt: "t", ...extra };
}

async function runDestroy(args: string[]): Promise<void> {
  await destroyCommand().parseAsync(args, { from: "user" });
}

beforeEach(() => {
  calls.length = 0;
  requestMock.mockClear();
  getMock.mockClear();
  process.env.CT_HOST = HOST;
});

afterEach(async () => {
  if (originalHost === undefined) delete process.env.CT_HOST;
  else process.env.CT_HOST = originalHost;
  await rm(statePath, { force: true });
});

describe("ct destroy (command level)", () => {
  it("blocks a target protected in STATE — with no config file loaded at all (#17 items 2+3)", async () => {
    const state = emptyState(HOST);
    state.resources.area = group("area", 1, { preventDestroy: true });
    await saveState(statePath, state);

    await expect(runDestroy(["--target", "area", "--state", statePath, "--force"])).rejects.toThrow(
      /preventDestroy is set \(in state\) for: area/,
    );
    // Nothing was deleted, and no config was consulted (the mock set has no loadConfig).
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("deletes a child before its parent using live hierarchy edges, ignoring --target order (#17 item 1)", async () => {
    const state = emptyState(HOST);
    state.resources.area = group("area", 1);
    state.resources.kids = group("kids", 2);
    await saveState(statePath, state);

    // --target lists the PARENT first; a tier-only order would DELETE /groups/1 while kids still refs it.
    await runDestroy(["--target", "area,kids", "--state", statePath, "--force"]);

    const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.path);
    expect(deletes).toEqual(["/groups/2", "/groups/1"]); // child (kids #2) before parent (area #1)
    const after = await loadState(statePath, HOST);
    expect(after.resources).toEqual({});
  });
});
