import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RawPermission } from "../src/permissions/grants.js";

const rows: RawPermission[] = [
  { authId: 1, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
];
const getMock = vi.fn(async (): Promise<RawPermission[]> => rows);

vi.mock("../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({ client: { get: getMock }, me: { id: 1 } })),
}));

const { adoptCommand } = await import("../src/commands/adopt.js");

const HOST = "https://eqrm.church.tools";
const originalHost = process.env.CT_HOST;

async function run(args: string[]): Promise<void> {
  await adoptCommand().parseAsync(args, { from: "user" });
}

beforeEach(() => {
  getMock.mockClear();
  process.env.CT_HOST = HOST;
});

afterEach(() => {
  if (originalHost === undefined) delete process.env.CT_HOST;
  else process.env.CT_HOST = originalHost;
});

describe("ct adopt grants", () => {
  it("fetches the domain's rows and prints a config block to stdout", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    try {
      await run(["grants", "group_type_role", "42", "--state", "/does/not/exist.json"]);
    } finally {
      spy.mockRestore();
    }
    expect(getMock).toHaveBeenCalledWith("/permissions/group_type_role/42");
    expect(writes.join("")).toContain("ct.groupTypeRole({");
  });

  it("accepts the hyphenated domain type spelling", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await run(["grants", "group-role", "7", "--state", "/does/not/exist.json"]);
    } finally {
      spy.mockRestore();
    }
    expect(getMock).toHaveBeenCalledWith("/permissions/group_role/7");
  });

  it("rejects an invalid domain type before any API call", async () => {
    await expect(run(["grants", "persons", "1"])).rejects.toThrow(/Invalid domain type/);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("rejects a non-integer domainId before any API call", async () => {
    await expect(run(["grants", "group_role", "3abc"])).rejects.toThrow(/expected a non-negative integer/);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("still runs the plain `adopt <type> <id>` action (subcommand does not shadow it)", async () => {
    // "campus" is not the "grants" subcommand → the base action runs and hits the resource path.
    getMock.mockResolvedValueOnce({ id: 0, name: "Mainz", shorty: "MZ" } as never);
    await run(["campus", "0", "--dry-run"]);
    expect(getMock).toHaveBeenCalledWith("/campuses/0");
  });
});
