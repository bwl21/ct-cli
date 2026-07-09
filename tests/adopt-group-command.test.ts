import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CtApiError } from "../src/api/ctClient.js";
import { buildPlan } from "../src/engine/build.js";
import { createContext } from "../src/config/context.js";
import type { CtClient } from "../src/api/ctClient.js";

/**
 * A tiny in-memory ChurchTools double covering everything `ct adopt group` reads:
 *  - `/groups/{id}` (single fetch), `/groups` (getAll, for --type)
 *  - `/groups/{id}/children` (for --children-of; includes a cyclic pair to exercise the guard)
 *  - `/group/grouptypes` (for --type's logical-key resolution)
 *  - `/dynamicgroups/{id}/ruleset` + `/status` (for --with-dynamic; #31 is deliberately NOT dynamic)
 */
function makeClient() {
  const groups: Record<number, Record<string, unknown>> = {
    10: { id: 10, name: "Area A", information: { groupTypeId: 5, groupStatusId: 1 } },
    11: { id: 11, name: "Area B", information: { groupTypeId: 5, groupStatusId: 1 } },
    20: { id: 20, name: "Other Type Group", information: { groupTypeId: 9, groupStatusId: 1 } },
    40: { id: 40, name: "Root", information: { groupTypeId: 5, groupStatusId: 1 } },
    41: { id: 41, name: "Child One", information: { groupTypeId: 5, groupStatusId: 1 } },
    42: { id: 42, name: "Child Two", information: { groupTypeId: 5, groupStatusId: 1 } },
    43: { id: 43, name: "Grandchild", information: { groupTypeId: 5, groupStatusId: 1 } },
    50: { id: 50, name: "Cycle A", information: { groupTypeId: 5, groupStatusId: 1 } },
    51: { id: 51, name: "Cycle B", information: { groupTypeId: 5, groupStatusId: 1 } },
    30: { id: 30, name: "All Mainz", information: { groupTypeId: 5, groupStatusId: 1 } },
    31: { id: 31, name: "Static Group", information: { groupTypeId: 5, groupStatusId: 1 } },
  };
  const children: Record<number, number[]> = {
    40: [41, 42],
    41: [43],
    50: [51], // cyclic: 50 -> 51 -> 50
    51: [50],
  };
  const groupTypes = [
    { id: 5, name: "Team" },
    { id: 9, name: "Other Type" },
  ];
  const rulesets: Record<number, Record<string, unknown>> = {
    30: { description: "x", query: { "==": [{ var: "a" }, "1"] }, process: {} },
  };
  const statuses: Record<number, string> = { 30: "active" };

  const get = vi.fn(async (path: string): Promise<unknown> => {
    let m = /^\/groups\/(\d+)$/.exec(path);
    if (m) {
      const g = groups[Number(m[1])];
      if (!g) throw new CtApiError("not found", 404, null);
      return g;
    }
    m = /^\/groups\/(\d+)\/children$/.exec(path);
    if (m) return (children[Number(m[1])] ?? []).map((id) => ({ id }));
    if (path === "/group/grouptypes") return groupTypes;
    m = /^\/dynamicgroups\/(\d+)\/ruleset$/.exec(path);
    if (m) {
      const rs = rulesets[Number(m[1])];
      if (!rs) throw new CtApiError("not found", 404, null);
      return rs;
    }
    m = /^\/dynamicgroups\/(\d+)\/status$/.exec(path);
    if (m) return { dynamicGroupStatus: statuses[Number(m[1])] ?? "none" };
    throw new CtApiError(`unmocked GET ${path}`, 404, null);
  });

  const getAll = vi.fn(async (path: string) => {
    if (path === "/groups") return { data: Object.values(groups) };
    throw new CtApiError(`unmocked getAll ${path}`, 404, null);
  });

  return { get, getAll };
}

let client = makeClient();

vi.mock("../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({ client, me: { id: 1 } })),
}));

const { adoptCommand } = await import("../src/commands/adopt.js");
const { loadState } = await import("../src/state/state.js");

const HOST = "https://eqrm.church.tools";
const originalHost = process.env.CT_HOST;
const originalCwd = process.cwd();

let workDir: string;
let statePath: string;

async function run(args: string[]): Promise<void> {
  await adoptCommand().parseAsync(args, { from: "user" });
}

beforeEach(() => {
  client = makeClient();
  process.env.CT_HOST = HOST;
  workDir = mkdtempSync(join(tmpdir(), "ct-adopt-group-"));
  process.chdir(workDir);
  statePath = join(workDir, "ct-state.json");
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
  if (originalHost === undefined) delete process.env.CT_HOST;
  else process.env.CT_HOST = originalHost;
});

describe("ct adopt group — multi-id list form", () => {
  it("adopts every listed group, in the given order, into one state file", async () => {
    await run(["group", "10", "11", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(state.resources.area_a).toMatchObject({ type: "group", id: 10 });
    expect(state.resources.area_b).toMatchObject({ type: "group", id: 11 });
    expect(Object.keys(state.resources)).toEqual(["area_a", "area_b"]);
  });

  it("prints a single grouped config block with a type comment header", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    try {
      await run(["group", "10", "11", "--state", statePath]);
    } finally {
      spy.mockRestore();
    }
    const block = writes.join("");
    expect(block).toContain("// group");
    expect(block).toContain('group({ key: "area_a"');
    expect(block).toContain('group({ key: "area_b"');
    // parents-before-children / declared order preserved: area_a's line precedes area_b's.
    expect(block.indexOf('key: "area_a"')).toBeLessThan(block.indexOf('key: "area_b"'));
  });

  it("dedupes a repeated id", async () => {
    await run(["group", "10", "10", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(Object.keys(state.resources)).toEqual(["area_a"]);
  });

  it("--dry-run adopts nothing and writes no state file", async () => {
    await run(["group", "10", "11", "--dry-run", "--state", statePath]);
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects --key with more than one id, before any network call", async () => {
    await expect(run(["group", "10", "11", "--key", "x", "--state", statePath])).rejects.toThrow(
      /single group/,
    );
    expect(client.get).not.toHaveBeenCalled();
  });

  it("rejects an invalid id before any network call", async () => {
    await expect(run(["group", "10", "abc", "--state", statePath])).rejects.toThrow(
      /expected a non-negative integer/,
    );
    expect(client.get).not.toHaveBeenCalled();
  });

  it("still supports the plain single-id form exactly as before", async () => {
    await run(["group", "10", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(state.resources.area_a).toMatchObject({
      type: "group",
      id: 10,
      fields: { name: "Area A", groupTypeId: 5, groupStatusId: 1 },
    });
  });
});

describe("ct adopt group --type", () => {
  it("adopts every group of a numeric group-type id, and none of another type", async () => {
    await run(["group", "--type", "5", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    const types = Object.values(state.resources).map((r) => r.id);
    expect(types).toEqual(expect.arrayContaining([10, 11, 40, 41, 42, 43, 50, 51, 30, 31]));
    expect(types).not.toContain(20); // group type 9 — excluded
  });

  it("resolves a logical group-type key against /group/grouptypes", async () => {
    await run(["group", "--type", "team", "--state", statePath]);
    expect(client.getAll).toHaveBeenCalledWith("/groups");
    const state = await loadState(statePath, HOST);
    expect(state.resources.area_a).toMatchObject({ id: 10 });
    expect(Object.values(state.resources).map((r) => r.id)).not.toContain(20);
  });

  it("rejects an unknown --type key", async () => {
    await expect(run(["group", "--type", "nope", "--state", statePath])).rejects.toThrow(
      /no group type matches/,
    );
  });

  it("rejects combining --type with explicit ids", async () => {
    await expect(run(["group", "10", "--type", "5", "--state", statePath])).rejects.toThrow(/only one of/);
  });
});

describe("ct adopt group --children-of", () => {
  it("recursively adopts the full subtree, parent before child, excluding the root itself", async () => {
    await run(["group", "--children-of", "40", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    const ids = Object.values(state.resources).map((r) => r.id);
    expect(ids.sort((a, b) => a - b)).toEqual([41, 42, 43]);
    expect(ids).not.toContain(40); // root itself is not re-adopted by --children-of
    // 41 (child of root) must be adopted before 43 (child of 41).
    const order = Object.values(state.resources).map((r) => r.id);
    expect(order.indexOf(41)).toBeLessThan(order.indexOf(43));
  });

  it("terminates on a cyclic hierarchy instead of looping forever (cycle guard)", async () => {
    await run(["group", "--children-of", "50", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    const ids = Object.values(state.resources).map((r) => r.id);
    expect(ids).toEqual([51]); // 50 -> 51 -> 50: only 51 is a new descendant
  });

  it("resolves --children-of by an already-adopted state key", async () => {
    await run(["group", "40", "--state", statePath]); // adopt the root first, under its derived key "root"
    await run(["group", "--children-of", "root", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(
      Object.values(state.resources)
        .map((r) => r.id)
        .sort((a, b) => a - b),
    ).toEqual([40, 41, 42, 43]);
  });

  it("reports an empty subtree without adopting anything", async () => {
    await run(["group", "--children-of", "42", "--state", statePath]); // 42 has no children
    const state = await loadState(statePath, HOST);
    expect(Object.keys(state.resources)).toEqual([]);
  });
});

describe("ct adopt group --with-dynamic", () => {
  it("captures a dynamic group's normalized ruleset to rulesets/<key>.json and emits the dynamic block", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    try {
      await run(["group", "30", "--with-dynamic", "--state", statePath]);
    } finally {
      spy.mockRestore();
    }
    const rulesetPath = join(workDir, "rulesets", "all_mainz.json");
    const written = JSON.parse(await readFile(rulesetPath, "utf8"));
    expect(written).toEqual({ description: "x", query: { "==": [{ var: "a" }, 1] }, process: {} }); // coerced "1" -> 1

    const block = writes.join("");
    // configSnippet renders a nested-object field value via JSON.stringify (compact, quoted keys) —
    // matches the existing tsObject behavior (see src/resources/registry.ts), unchanged by #51.
    expect(block).toContain('dynamic: {"status":"active","ruleset":{"ref":"./rulesets/all_mainz.json"}}');

    // The plain group fields (state snapshot) never carry "dynamic" — it's synthetic, not a managed field.
    const state = await loadState(statePath, HOST);
    expect(state.resources.all_mainz?.fields).not.toHaveProperty("dynamic");
  });

  it("skips a non-dynamic group silently: no file, no dynamic block, no error", async () => {
    await run(["group", "31", "--with-dynamic", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    expect(state.resources.static_group).toMatchObject({ id: 31 });
    await expect(readFile(join(workDir, "rulesets", "static_group.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("--dry-run --with-dynamic previews the dynamic block without writing the ruleset file", async () => {
    await run(["group", "30", "--with-dynamic", "--dry-run", "--state", statePath]);
    await expect(readFile(join(workDir, "rulesets", "all_mainz.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("works across a bulk selection: captures dynamic only for the groups that are actually dynamic", async () => {
    await run(["group", "30", "31", "--with-dynamic", "--state", statePath]);
    const rulesetPath = join(workDir, "rulesets", "all_mainz.json");
    await expect(readFile(rulesetPath, "utf8")).resolves.toBeTruthy();
    await expect(readFile(join(workDir, "rulesets", "static_group.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("end-to-end: adopting a dynamic group with --with-dynamic makes `ct plan` a no-op (#51 acceptance)", async () => {
    await run(["group", "30", "--with-dynamic", "--state", statePath]);
    const state = await loadState(statePath, HOST);
    const managed = state.resources.all_mainz!;

    // Reconstruct the config a user would paste from the printed snippet: the plain group fields
    // plus the emitted `dynamic` block, referencing the file `--with-dynamic` just wrote.
    const { ct, resources } = createContext();
    ct.group({
      key: "all_mainz",
      name: managed.fields.name as string,
      groupTypeId: managed.fields.groupTypeId as number,
      groupStatusId: managed.fields.groupStatusId as number,
      dynamic: { status: "active", ruleset: { ref: "./rulesets/all_mainz.json" } },
    });

    const { plan } = await buildPlan(client as unknown as Pick<CtClient, "get">, state, resources, {
      configDir: workDir,
    });
    expect(plan.items.every((i) => i.action === "no-op")).toBe(true);
  });
});
