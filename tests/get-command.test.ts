import { describe, it, expect, vi, beforeEach } from "vitest";

const getAllMock = vi.fn();
const getMock = vi.fn();
const getRawMock = vi.fn();

vi.mock("../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({
    client: { get: getMock, getAll: getAllMock, getRaw: getRawMock },
    me: { id: 1 },
  })),
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
    getRawMock.mockReset();
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
        {
          id: 9,
          name: "bezeichnung",
          securityLevel: 2,
          fieldCategory: { internCode: "f_group", table: "cdb_gruppe" },
        },
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
    getRawMock.mockRejectedValue(
      new CtApiError("GET /groups?limit=500 failed", 400, { errors: ["limit exceeds max of 100"] }),
    );

    await expect(runGet(["raw", "/groups?limit=500"])).rejects.toMatchObject({
      name: "CtApiError",
      status: 400,
    });
  });
});

/**
 * `ct get raw` used to issue exactly one request and print whatever came back — which for any CT list
 * endpoint is its default first page. `ct get raw "/groups"` therefore reported 10 rows on an instance
 * with 645, in a valid-looking JSON array, while `ct get groups` on the same path reported all 645.
 */
describe("ct get raw pagination (#100)", () => {
  beforeEach(() => {
    getAllMock.mockReset();
    getMock.mockReset();
    getRawMock.mockReset();
  });

  it("follows pagination instead of returning CT's default first page", async () => {
    getRawMock.mockResolvedValue({
      data: Array.from({ length: 10 }, (_, i) => ({ id: i })),
      meta: { pagination: { total: 645, current: 1, lastPage: 65, limit: 10 } },
    });
    getAllMock.mockResolvedValue({
      data: Array.from({ length: 645 }, (_, i) => ({ id: i })),
      meta: { pagination: { total: 645, current: 65, lastPage: 65, limit: 10 } },
    });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runGet(["raw", "/groups"]);

    expect(getAllMock).toHaveBeenCalledWith("/groups");
    const printed = JSON.parse(writeSpy.mock.calls[0]?.[0] as string) as unknown[];
    expect(printed).toHaveLength(645);
    writeSpy.mockRestore();
  });

  it("prints a single-object response as-is and never appends paging params to it", async () => {
    getRawMock.mockResolvedValue({ data: { id: 42, name: "Kids" } });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runGet(["raw", "/groups/42"]);

    expect(getRawMock).toHaveBeenCalledWith("/groups/42");
    expect(getAllMock).not.toHaveBeenCalled();
    expect(JSON.parse(writeSpy.mock.calls[0]?.[0] as string)).toEqual({ id: 42, name: "Kids" });
    writeSpy.mockRestore();
  });

  it("makes exactly one request for an unpaginated list", async () => {
    getRawMock.mockResolvedValue({
      data: [{ id: 1 }, { id: 2 }],
      meta: { pagination: { total: 2, current: 1, lastPage: 1 } },
    });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runGet(["raw", "/departments"]);

    expect(getAllMock).not.toHaveBeenCalled();
    expect(JSON.parse(writeSpy.mock.calls[0]?.[0] as string)).toHaveLength(2);
    writeSpy.mockRestore();
  });

  it("--no-paginate keeps the single-request probe but WARNS that rows were dropped", async () => {
    getRawMock.mockResolvedValue({
      data: Array.from({ length: 10 }, (_, i) => ({ id: i })),
      meta: { pagination: { total: 645, current: 1, lastPage: 65 } },
    });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runGet(["raw", "/groups", "--no-paginate"]);

    expect(getAllMock).not.toHaveBeenCalled();
    expect(JSON.parse(writeSpy.mock.calls[0]?.[0] as string)).toHaveLength(10);
    expect(errSpy.mock.calls.map(String).join("")).toContain("INCOMPLETE: returned 10 of 645 row(s)");
    writeSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("--page <n> probes exactly that page", async () => {
    getRawMock.mockResolvedValue({
      data: [{ id: 300 }],
      meta: { pagination: { total: 645, current: 3, lastPage: 65 } },
    });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runGet(["raw", "/groups", "--page", "3"]);

    expect(getRawMock).toHaveBeenCalledWith("/groups?page=3&limit=100");
    expect(getAllMock).not.toHaveBeenCalled();
    writeSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("honours a caller's own page=/limit= verbatim rather than appending a conflicting pair", async () => {
    getRawMock.mockResolvedValue({
      data: [{ id: 1 }],
      meta: { pagination: { total: 1, current: 1, lastPage: 1 } },
    });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runGet(["raw", "/groups?limit=100&page=2"]);

    expect(getRawMock).toHaveBeenCalledWith("/groups?limit=100&page=2");
    expect(getAllMock).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it("rejects a nonsense --page instead of silently probing page 1", async () => {
    await expect(runGet(["raw", "/groups", "--page", "0"])).rejects.toThrow(/Invalid --page/);
  });

  // Both spellings are explicit, so neither may be silently dropped. Appending anyway produced
  // `?limit=50&page=2&limit=100` — a duplicated param whose winner is the server's parsing rule.
  it("rejects --page combined with page/limit already in the path", async () => {
    await expect(runGet(["raw", "/groups?limit=50", "--page", "2"])).rejects.toThrow(
      /--page 2 conflicts with the page\/limit already in the path/,
    );
    expect(getRawMock).not.toHaveBeenCalled();
  });
});
