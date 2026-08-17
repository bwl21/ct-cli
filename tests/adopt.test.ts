import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeCampus: Record<string, unknown> = { id: 0, name: "Mainz", shorty: "MZ" };
const getMock = vi.fn(async (...args: [string?]): Promise<Record<string, unknown>> => {
  void args;
  return fakeCampus;
});
// The ReverseResolver reads its master-data catalogs through `getAll` (#101): a plain `get` returns
// only CT's default first page, which silently truncated every id→key map on a real instance.
const getAllMock = vi.fn(async (path: string): Promise<{ data: unknown[] }> => {
  const single = await getMock(path);
  return { data: Array.isArray(single) ? single : [single] };
});

vi.mock("../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({ client: { get: getMock, getAll: getAllMock }, me: { id: 1 } })),
}));

const { adoptCommand } = await import("../src/commands/adopt.js");
const { loadState } = await import("../src/state/state.js");

const statePath = join(tmpdir(), `ct-cli-adopt-${process.pid}.json`);
const HOST = "https://mychurch.church.tools";

async function runAdopt(args: string[]): Promise<void> {
  await adoptCommand().parseAsync(args, { from: "user" });
}

const originalHost = process.env.CT_HOST;

beforeEach(() => {
  getMock.mockClear();
  process.env.CT_HOST = HOST; // host is now resolved from env/stored login, not a hardcoded default
});

afterEach(async () => {
  if (originalHost === undefined) {
    delete process.env.CT_HOST;
  } else {
    process.env.CT_HOST = originalHost;
  }
  await rm(statePath, { force: true });
});

describe("ct adopt", () => {
  it("adopts a campus (id 0) into the state file", async () => {
    await runAdopt(["campus", "0", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    // The key comes from `name`, like every other resource (#118) — not from `shorty` ("MZ").
    expect(state.resources.mainz).toMatchObject({
      type: "campus",
      id: 0,
      key: "mainz",
      fields: { name: "Mainz", shorty: "MZ" },
    });
    expect(state.resources.mz).toBeUndefined();
  });

  it("captures a campus-assigned group's campusId from information (#21)", async () => {
    getMock.mockResolvedValueOnce({
      id: 12,
      name: "Kids Team",
      information: { groupTypeId: 2, groupStatusId: 1, campusId: 4 },
    });
    await runAdopt(["group", "12", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(state.resources.kids_team).toMatchObject({
      type: "group",
      id: 12,
      fields: { name: "Kids Team", groupTypeId: 2, groupStatusId: 1, campusId: 4 },
    });
  });

  it("is idempotent — re-adopting keeps a single entry", async () => {
    await runAdopt(["campus", "0", "--state", statePath]);
    await runAdopt(["campus", "0", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(Object.keys(state.resources)).toHaveLength(1);
  });

  it("honours an explicit --key", async () => {
    await runAdopt(["campus", "0", "--key", "mainz", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(state.resources.mainz?.id).toBe(0);
  });

  it("--dry-run does not write the state file", async () => {
    await runAdopt(["campus", "0", "--dry-run", "--state", statePath]);
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  // Bereiche have NO `/departments/{id}` path (#108) — reading through the default item path 404s on
  // every single invocation, so adopt has to go through the spec's own `fetchOne`.
  it("reads a type with no item path through fetchOne, not through /<collection>/<id>", async () => {
    const rows = [{ id: 7, name: "Equippers Koblenz", shorty: "EQKO", sortKey: 0 }];
    const paths: string[] = [];
    const original = getMock.getMockImplementation()!;
    getMock.mockImplementation(async (path?: string) => {
      paths.push(path!);
      if (path === "/departments") return rows as unknown as Record<string, unknown>;
      return original(path);
    });
    try {
      await runAdopt(["department", "7", "--state", statePath]);
    } finally {
      getMock.mockImplementation(original);
    }

    const state = await loadState(statePath, HOST);
    expect(state.resources.equippers_koblenz).toMatchObject({ type: "department", id: 7 });
    expect(paths).toContain("/departments");
    expect(paths.some((p) => p.startsWith("/departments/"))).toBe(false);
  });

  it("errors clearly when a fetchOne type has no row with that id", async () => {
    const original = getMock.getMockImplementation()!;
    getMock.mockImplementation(async (path?: string) => {
      if (path === "/departments") return [] as unknown as Record<string, unknown>;
      return original(path);
    });
    try {
      await expect(runAdopt(["department", "99", "--state", statePath])).rejects.toThrow(
        /No department with id 99 exists in ChurchTools/,
      );
    } finally {
      getMock.mockImplementation(original);
    }
  });

  it("rejects an unknown resource type before any API call", async () => {
    await expect(runAdopt(["widget", "1", "--state", statePath])).rejects.toThrow(/Adoptable types/);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("rejects a non-integer id (trailing garbage) before any API call", async () => {
    await expect(runAdopt(["campus", "3abc", "--state", statePath])).rejects.toThrow(
      /expected a non-negative integer/,
    );
    await expect(runAdopt(["campus", "0x10", "--state", statePath])).rejects.toThrow(
      /expected a non-negative integer/,
    );
    expect(getMock).not.toHaveBeenCalled();
  });
});
