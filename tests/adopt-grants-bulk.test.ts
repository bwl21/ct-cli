/**
 * Bulk `ct adopt grants` (#104).
 *
 * Adopting the declarable estate of a real instance used to mean one invocation and one manual paste
 * per role instance, each needing its `key` renamed and its emitted numeric `id:` swapped for the
 * portable `group` + `role` pair — the two edits a human forgets on the 30th paste. These tests pin
 * the portable emission, the derived key, and the refusal to emit a revoking block in bulk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawPermission } from "../src/permissions/grants.js";
import type { State } from "../src/state/state.js";

/** `churchcore:administer settings` (unscoped) and `churchgroup:view group` (`cdb_gruppe`). */
const UNSCOPED = 1;
const VIEW_GROUP = 1104;
/** `churchcore:use church html templates` — `cc_html_template`, module data with no resource. */
const HTML_TEMPLATE = 17;

const perm = (authId: number, domainId: number, dataId: number | null = null): RawPermission => ({
  authId,
  dataId,
  type: "grant",
  domainId,
  meta: { modifiedPid: 5 },
});

/**
 * Two groups. `kids` (#10, managed as "kids") has a declarable Leiter role and a Mitglied role blocked
 * by a module dimension; `ops` (#11, unmanaged) has a declarable Leiter role.
 */
const groupRows = [
  {
    id: 10,
    name: "Kids",
    information: { groupTypeId: 2 },
    roles: [
      { id: 100, groupTypeRoleId: 16 },
      { id: 101, groupTypeRoleId: 17 },
    ],
  },
  { id: 11, name: "Ops", information: { groupTypeId: 2 }, roles: [{ id: 200, groupTypeRoleId: 16 }] },
  // `youth` (#12, managed) carries its rights ONLY as inherited rows — the #119 shape.
  { id: 12, name: "Youth", information: { groupTypeId: 2 }, roles: [{ id: 300, groupTypeRoleId: 16 }] },
];
const roleDefRows = [
  { id: 16, name: "Leiter", groupTypeId: 2 },
  { id: 17, name: "Mitglied", groupTypeId: 2 },
];
const permissions: RawPermission[] = [
  perm(UNSCOPED, 100),
  perm(VIEW_GROUP, 100, 10),
  perm(UNSCOPED, 101),
  perm(HTML_TEMPLATE, 101, 3), // blocks role instance 101
  perm(UNSCOPED, 200),
  { ...perm(UNSCOPED, 300), isInherited: true },
  { ...perm(VIEW_GROUP, 300, 12), isInherited: true },
];

const getMock = vi.fn(async (path: string): Promise<unknown> => {
  if (path === "/permissions/group_role") return permissions;
  const m = /^\/permissions\/group_role\/(\d+)$/.exec(path);
  if (m) return permissions.filter((p) => p.domainId === Number(m[1]));
  throw new Error(`unmocked GET ${path}`);
});
const getAllMock = vi.fn(async (path: string): Promise<{ data: unknown[] }> => {
  if (path.startsWith("/groups")) return { data: groupRows };
  if (path === "/group/roles") return { data: roleDefRows };
  throw new Error(`unmocked getAll ${path}`);
});

vi.mock("../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({ client: { get: getMock, getAll: getAllMock }, me: { id: 1 } })),
}));

const { adoptCommand } = await import("../src/commands/adopt.js");

const HOST = "https://mychurch.church.tools";
const originalHost = process.env.CT_HOST;
let workDir: string;
let statePath: string;

const state: State = {
  version: 1,
  host: HOST,
  resources: {
    kids: { type: "group", id: 10, key: "kids", fields: { name: "Kids" }, adoptedAt: "t", updatedAt: "t" },
    youth: { type: "group", id: 12, key: "youth", fields: { name: "Youth" }, adoptedAt: "t", updatedAt: "t" },
  },
};

async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const outs: string[] = [];
  const errs: string[] = [];
  const o = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    outs.push(String(s));
    return true;
  });
  const e = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    errs.push(String(s));
    return true;
  });
  try {
    await adoptCommand().parseAsync([...args, "--state", statePath], { from: "user" });
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
  return { stdout: outs.join(""), stderr: errs.join("") };
}

beforeEach(() => {
  getMock.mockClear();
  getAllMock.mockClear();
  process.env.CT_HOST = HOST;
  workDir = mkdtempSync(join(tmpdir(), "ct-adopt-grants-bulk-"));
  statePath = join(workDir, "ct-state.json");
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
});

afterEach(() => {
  if (originalHost === undefined) delete process.env.CT_HOST;
  else process.env.CT_HOST = originalHost;
  rmSync(workDir, { recursive: true, force: true });
});

describe("ct adopt grants --group (#104)", () => {
  it("emits the PORTABLE group + role form and a derived key when the group is managed", async () => {
    const { stdout } = await run(["grants", "--group", "kids"]);
    expect(stdout).toContain('key: "kids_leiter"');
    expect(stdout).toContain('group: "kids"');
    expect(stdout).toContain('role: "Leiter"');
    // The host-specific pairing id is exactly what the portable form replaces.
    expect(stdout).not.toContain("id: 100");
  });

  it("skips the role instance blocked by a module dimension, and says which and why", async () => {
    const { stdout, stderr } = await run(["grants", "--group", "kids"]);
    expect(stdout).not.toContain("kids_mitglied");
    expect(stderr).toContain("Kids / Mitglied (domainId 101)");
    expect(stderr).toContain("cc_html_template");
    expect(stderr).toContain("preserveUnknown");
  });

  it("falls back to the numeric id form when the group is NOT managed", async () => {
    const { stdout } = await run(["grants", "--group", "11"]);
    expect(stdout).toContain("id: 200");
    expect(stdout).toContain("host-specific — adopt the group");
    expect(stdout).not.toContain('group: "');
  });

  it("resolves --group by live name as well as by managed key and numeric id", async () => {
    const { stdout } = await run(["grants", "--group", "Kids"]);
    expect(stdout).toContain('group: "kids"');
  });

  it("summarises what it emitted and what it did not — never a silent cap", async () => {
    const { stderr } = await run(["grants", "--group", "kids"]);
    expect(stderr).toMatch(/1 block\(s\) emitted .* 1 skipped \(not declarable\)/);
  });
});

describe("ct adopt grants --all-declarable (#104)", () => {
  it("emits every declarable role instance on the host in one invocation", async () => {
    const { stdout } = await run(["grants", "--all-declarable"]);
    expect(stdout).toContain('key: "kids_leiter"');
    expect(stdout).toContain("id: 200"); // the unmanaged group's declarable role, numeric form
    expect(stdout).not.toContain("kids_mitglied");
  });

  // The bulk counterpart of #119. The single-domain path emits the effective set; the bulk path used
  // to decide whether to emit at all from the OWNED set, so a domain whose rights are all inherited
  // here counted as "no authored grants" and was skipped. Its rights then stay undeclared — and on the
  // host that materialises the same rights as DIRECT rows, the next plan puts them in toDelete.
  it("emits a domain whose grants are all inherited, rather than counting it empty", async () => {
    const { stdout } = await run(["grants", "--all-declarable"]);
    expect(stdout).toContain('key: "youth_leiter"');
    expect(stdout).toContain('group: "youth"');
    expect(stdout).toContain("churchgroup:view group");
  });

  it("--write appends the blocks to a file instead of printing them", async () => {
    const target = join(workDir, "grants.ts");
    writeFileSync(target, "// existing\n", "utf8");
    const { stdout } = await run(["grants", "--all-declarable", "--write", target]);
    const written = readFileSync(target, "utf8");
    expect(written).toContain("// existing");
    expect(written).toContain('key: "kids_leiter"');
    expect(stdout).not.toContain("ct.groupRole"); // went to the file, not stdout
  });
});

describe("ct adopt grants — argument guards (#104)", () => {
  it("rejects mixing a positional domain with a bulk selector", async () => {
    await expect(run(["grants", "group_role", "100", "--group", "kids"])).rejects.toThrow(/not both/);
  });

  it("rejects both bulk selectors at once", async () => {
    await expect(run(["grants", "--group", "kids", "--all-declarable"])).rejects.toThrow(
      /only one of: --group, --all-declarable/,
    );
  });

  it("still supports the original single-domain form", async () => {
    const { stdout } = await run(["grants", "group_role", "100"]);
    expect(getMock).toHaveBeenCalledWith("/permissions/group_role/100");
    // The single form keeps its pre-#104 shape: numeric id, rename-to-taste key.
    expect(stdout).toContain("id: 100");
    expect(stdout).toContain("rename to taste");
  });

  it("explains what to pass when given nothing at all", async () => {
    await expect(run(["grants"])).rejects.toThrow(/Specify <domainType> <domainId>/);
  });
});
