/**
 * The guard on `GET /permissions/<domainType>` (review of #100/#103/#104/#105).
 *
 * Every permission read was a plain `client.get`, on the unchecked belief that a permission domain
 * returns one instance-wide blob rather than a paged list. If that is ever wrong, the failure is
 * completely silent: `request()` drops `meta`, so a first page of 10 rows is indistinguishable from
 * a complete answer — `ct plan` sees a truncated actual set, `ct coverage` under-reports, and
 * `ct adopt grants --all-declarable` files most role instances under "no authored grants".
 */
import { describe, it, expect, vi } from "vitest";
import { fetchPermissionRows } from "../src/permissions/fetch.js";

const row = (id: number) => ({ id, domainType: "group_role", domainId: id, authId: 1, isInherited: false });

describe("fetchPermissionRows", () => {
  it("costs exactly one request while the endpoint returns no pagination block", async () => {
    const getRaw = vi.fn(async () => ({ data: [row(1), row(2)] }));
    const getAll = vi.fn();
    const rows = await fetchPermissionRows(
      { get: vi.fn(), getRaw, getAll } as never,
      "/permissions/group_role",
    );
    expect(rows).toHaveLength(2);
    expect(getRaw).toHaveBeenCalledWith("/permissions/group_role");
    expect(getAll).not.toHaveBeenCalled();
  });

  it("pages the endpoint properly when meta says more rows exist than arrived", async () => {
    const getRaw = vi.fn(async () => ({
      data: [row(1)],
      meta: { pagination: { total: 300, current: 1, lastPage: 3, limit: 100 } },
    }));
    const getAll = vi.fn(async () => ({ data: [row(1), row(2), row(3)] }));
    const rows = await fetchPermissionRows(
      { get: vi.fn(), getRaw, getAll } as never,
      "/permissions/group_role",
    );
    expect(rows).toHaveLength(3);
    expect(getAll).toHaveBeenCalledWith("/permissions/group_role");
  });

  it("also catches a `total` reported without page numbers", async () => {
    const getRaw = vi.fn(async () => ({ data: [row(1)], meta: { pagination: { total: 42 } } }));
    const getAll = vi.fn(async () => ({ data: [row(1), row(2)] }));
    const rows = await fetchPermissionRows({ get: vi.fn(), getRaw, getAll } as never, "/permissions/status");
    expect(rows).toHaveLength(2);
  });

  it("falls back to the plain read for a narrow client that has no envelope access", async () => {
    const get = vi.fn(async () => [row(1)]);
    const rows = await fetchPermissionRows({ get } as never, "/permissions/group_role");
    expect(rows).toEqual([row(1)]);
    expect(get).toHaveBeenCalledWith("/permissions/group_role");
  });

  it("returns [] for a non-array body rather than letting it reach the diff", async () => {
    const getRaw = vi.fn(async () => ({ data: { message: "nope" } }));
    const rows = await fetchPermissionRows(
      { get: vi.fn(), getRaw, getAll: vi.fn() } as never,
      "/permissions/group_role",
    );
    expect(rows).toEqual([]);
  });
});
