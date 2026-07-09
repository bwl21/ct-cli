import { describe, it, expect, vi, beforeEach } from "vitest";

const getAllMock = vi.fn();
const getMock = vi.fn();

vi.mock("../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({ client: { get: getMock, getAll: getAllMock }, me: { id: 1 } })),
}));

const { getCommand } = await import("../src/commands/get.js");
const { CtApiError } = await import("../src/api/ctClient.js");

async function runGet(args: string[]): Promise<void> {
  await getCommand().parseAsync(args, { from: "user" });
}

describe("ct get (#50)", () => {
  beforeEach(() => {
    getAllMock.mockReset();
    getMock.mockReset();
  });

  it("auto-paginates a list resource and prints every item, not just the first page", async () => {
    const allGroups = Array.from({ length: 250 }, (_, i) => ({ id: i }));
    getAllMock.mockResolvedValue({
      data: allGroups,
      meta: { pagination: { total: 250, current: 3, lastPage: 3, limit: 100 } },
    });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runGet(["groups"]);

    expect(getAllMock.mock.calls[0]?.[0]).toBe("/groups");
    const printed = JSON.parse(writeSpy.mock.calls[0]?.[0] as string) as unknown[];
    expect(printed).toHaveLength(250);
    writeSpy.mockRestore();
  });

  it("prints the total from meta.pagination to stderr for list output", async () => {
    getAllMock.mockResolvedValue({
      data: [{ id: 1 }],
      meta: { pagination: { total: 1, current: 1, lastPage: 1, limit: 100 } },
    });
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runGet(["groups"]);

    const combined = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(combined).toContain("1");
    errSpy.mockRestore();
  });

  it("uses the plain (unpaginated) get for whoami, a single-object resource", async () => {
    getMock.mockResolvedValue({ id: 1 });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runGet(["whoami"]);

    expect(getMock).toHaveBeenCalledWith("/whoami");
    expect(getAllMock).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it("reads person master-data (incl. the security-level model) as a single object via plain get (#47)", async () => {
    // `/person/masterdata` is the versionable person master-data model (sexes, statuses,
    // campuses, and the security-level enumeration the churchdb permission scopes reference).
    // It is a single object, not a paged list — so it must use the unpaginated path.
    getMock.mockResolvedValue({ securityLevels: [{ id: 1, name: "Öffentlich" }], sexes: [] });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runGet(["person-masterdata"]);

    expect(getMock).toHaveBeenCalledWith("/person/masterdata");
    expect(getAllMock).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it("reads the unified data-field definitions (person + group Datenfelder) via getAll (#47/#48)", async () => {
    // `/dbfields` is the unified field-DEFINITION catalog: person master-data fields AND group
    // custom fields, discriminated by each field's `fieldCategory` (e.g. table `cdb_gruppe` for
    // group fields). List-shaped, so it auto-paginates. Field VALUES on records are never read.
    getAllMock.mockResolvedValue({
      data: [
        { id: 5, name: "first_contact", securityLevel: 1, fieldCategory: { internCode: "f_person" } },
        { id: 9, name: "bezeichnung", securityLevel: 2, fieldCategory: { internCode: "f_group", table: "cdb_gruppe" } },
      ],
      meta: { pagination: { total: 2, current: 1, lastPage: 1, limit: 100 } },
    });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runGet(["data-fields"]);

    expect(getAllMock.mock.calls[0]?.[0]).toBe("/dbfields");
    const printed = JSON.parse(writeSpy.mock.calls[0]?.[0] as string) as unknown[];
    expect(printed).toHaveLength(2);
    writeSpy.mockRestore();
  });

  it("propagates a raw call's CtApiError (status + body) instead of swallowing it", async () => {
    getMock.mockRejectedValue(
      new CtApiError("GET /groups?limit=500 failed", 400, { errors: ["limit exceeds max of 100"] }),
    );

    await expect(runGet(["raw", "/groups?limit=500"])).rejects.toMatchObject({
      name: "CtApiError",
      status: 400,
    });
  });
});
