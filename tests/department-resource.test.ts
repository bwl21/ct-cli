/**
 * Bereiche/departments as a managed resource (#108) — the one type whose READS are REST and whose
 * WRITES are not.
 *
 * `GET /departments` is a normal catalog; no REST write verb exists for it. The admin UI creates a
 * Bereich through the legacy master-data endpoint, and so does `ct` now. Verified live on eqrm-dev,
 * CT 3.135.2, 2026-08-14 (create → update-by-id → delete, `GET /departments` reflecting each step,
 * instance left as found):
 *
 *   func=saveMasterData&table=cdb_bereich&id=&col0=bezeichnung&value0=…  → {"status":"success","data":null}
 *   func=saveMasterData&table=cdb_bereich&id=3&col0=bezeichnung&value0=… → {"status":"success","data":null}
 *   func=deleteMasterData&table=cdb_bereich&id=3                        → {"status":"success","data":null}
 *
 * Why it matters: before this, a Bereich-scoped grant only planned on a host where somebody had
 * already created the Bereich by hand, so `ct` could not stand up a fresh instance from config — the
 * assumption the whole dev→prod promotion model rests on.
 */
import { describe, it, expect } from "vitest";
import { executePlan } from "../src/engine/execute.js";
import { fetchActual } from "../src/engine/build.js";
import { RESOURCES } from "../src/resources/registry.js";
import { masterDataColumns, masterDataTable, DEPARTMENT_TABLE } from "../src/api/masterdata.js";
import { emptyState, type State } from "../src/state/state.js";
import type { Plan } from "../src/engine/types.js";

const noSave: (path: string, state: State) => Promise<void> = async () => {};
const fixedNow = () => "2026-08-14T00:00:00.000Z";

/** The `cdb_bereich` descriptor exactly as eqrm-dev reports it (CT 3.135.2, 2026-08-14). */
const BEREICH_TABLE = {
  id: 3,
  bezeichnung: "Bereich",
  shortname: "dep",
  tablename: "cdb_bereich",
  desc: {
    id: { field: "id", type: "int(11)", null: "NO", key: "PRI", default: null, extra: "auto_increment" },
    bezeichnung: { field: "bezeichnung", type: "varchar(50)", null: "NO", key: "", default: null, extra: "" },
    kuerzel: { field: "kuerzel", type: "varchar(10)", null: "NO", key: "", default: null, extra: "" },
    sortkey: { field: "sortkey", type: "int(11)", null: "NO", key: "", default: "0", extra: "" },
  },
};

/**
 * A client exposing REST `request`/`getAll` plus the legacy `ajax` channel, recording both.
 *
 * The catalog is LIVE, not a frozen list: a `saveMasterData` create appends a row the way CT does,
 * so `GET /departments` afterwards differs from before. That asymmetry is the whole mechanism the
 * writer relies on to learn the new id (the endpoint returns none), so a double that answered the
 * same rows before and after would test nothing. `options.createdId` forces the id CT mints;
 * `options.mintsNothing` makes the write a silent no-op (the "row never appeared" failure path).
 */
function recorder(
  departments: { id: number; name: string; shorty?: string; sortKey?: number }[] = [],
  options: { createdId?: number; mintsNothing?: boolean } = {},
) {
  const ajaxCalls: { module: string; params: Record<string, string> }[] = [];
  const restCalls: { method: string; path: string; body?: unknown }[] = [];
  const rows = [...departments];
  const client = {
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      restCalls.push({ method, path, body });
      return {} as T;
    },
    getAll: async <T>(path: string): Promise<{ data: T[] }> => {
      restCalls.push({ method: "GET", path });
      return { data: [...rows] as T[] };
    },
    ajax: async <T>(module: string, params: Record<string, string>): Promise<T> => {
      ajaxCalls.push({ module, params });
      if (params.func === "getMasterData") return { masterDataTables: { "3": BEREICH_TABLE } } as T;
      if (params.func === "saveMasterData" && params.id === "" && !options.mintsNothing) {
        // `col0=bezeichnung&value0=<name>` — mirror CT and append the row under its REST name.
        rows.push({ id: options.createdId ?? 7, name: params.value0! });
      }
      return null as T;
    },
  };
  return { client, ajaxCalls, restCalls };
}

describe("create goes through saveMasterData, then re-reads REST for the id (#108)", () => {
  it("posts the mapped columns with an EMPTY id, then records the id from GET /departments", async () => {
    const state = emptyState("h");
    // Empty instance; the write itself puts the Bereich in the catalog (see `recorder`).
    const { client, ajaxCalls, restCalls } = recorder([], { createdId: 7 });
    const plan: Plan = {
      items: [
        {
          type: "department",
          key: "equippers_koblenz",
          id: null,
          action: "create",
          changes: [
            { field: "name", from: undefined, to: "Equippers Koblenz" },
            { field: "shorty", from: undefined, to: "EQKO" },
            { field: "sortKey", from: undefined, to: 0 },
          ],
        },
      ],
    };

    const res = await executePlan(plan, { client, state, statePath: "unused", save: noSave, now: fixedNow });
    expect(res.failed).toBeUndefined();
    expect(res.created).toEqual(["equippers_koblenz"]);

    // No REST write — that is the point. The only REST calls are the id lookups either side of it:
    // the new row is identified by DIFFING the catalog, so both reads are load-bearing.
    expect(restCalls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(restCalls).toEqual([
      { method: "GET", path: "/departments" },
      { method: "GET", path: "/departments" },
    ]);

    // The registry is read first (to validate columns), then the write.
    expect(ajaxCalls[0]).toEqual({ module: "churchdb", params: { func: "getMasterData" } });
    expect(ajaxCalls[1]).toEqual({
      module: "churchdb",
      params: {
        func: "saveMasterData",
        table: "cdb_bereich",
        id: "", // empty = create
        col0: "bezeichnung",
        value0: "Equippers Koblenz",
        col1: "kuerzel",
        value1: "EQKO",
        col2: "sortkey",
        value2: "0",
      },
    });
    expect(state.resources.equippers_koblenz).toMatchObject({ type: "department", id: 7 });
  });

  it("refuses BEFORE writing when a Bereich of that name already exists", async () => {
    // The ordinary collision: somebody made the Bereich by hand on the target host. Checking only
    // AFTER the write would be worse than useless — the create would have succeeded, the ambiguity
    // error would abort before state recorded anything, and every re-run would add another orphan.
    const state = emptyState("h");
    const { client, ajaxCalls } = recorder([{ id: 7, name: "Doppelt" }]);
    const plan: Plan = {
      items: [
        {
          type: "department",
          key: "doppelt",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "Doppelt" }],
        },
      ],
    };
    const res = await executePlan(plan, { client, state, statePath: "unused", save: noSave, now: fixedNow });
    expect(res.failed?.key).toBe("doppelt");
    expect(res.failed?.message).toMatch(/already exists in ChurchTools \(#7\)/);
    // Nothing was written: no saveMasterData reached the legacy endpoint at all.
    expect(ajaxCalls.filter((c) => c.params.func === "saveMasterData")).toEqual([]);
    expect(state.resources.doppelt).toBeUndefined();
  });

  it("fails loudly when the write leaves no new row in the catalog", async () => {
    const state = emptyState("h");
    const { client } = recorder([{ id: 7, name: "Andere" }], { mintsNothing: true });
    const plan: Plan = {
      items: [
        {
          type: "department",
          key: "neu",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "Neu" }],
        },
      ],
    };
    const res = await executePlan(plan, { client, state, statePath: "unused", save: noSave, now: fixedNow });
    expect(res.failed?.key).toBe("neu");
    expect(res.failed?.message).toMatch(/no new row appeared in GET \/departments/);
    expect(state.resources.neu).toBeUndefined();
  });
});

describe("update reuses the same call with a non-empty id (#108)", () => {
  it("sends the FULL snapshot, not just the changed column", async () => {
    // The legacy endpoint writes the columns it is handed and is closer to a PUT than a PATCH, so a
    // subset would blank the untouched ones.
    const state: State = {
      version: 1,
      host: "h",
      resources: {
        equippers_koblenz: {
          type: "department",
          id: 7,
          key: "equippers_koblenz",
          fields: { name: "Equippers Koblenz", shorty: "EQKO", sortKey: 0 },
          adoptedAt: "t",
          updatedAt: "t",
        },
      },
    };
    const { client, ajaxCalls, restCalls } = recorder();
    const plan: Plan = {
      items: [
        {
          type: "department",
          key: "equippers_koblenz",
          id: 7,
          action: "update",
          actual: { name: "Equippers Koblenz", shorty: "EQKO", sortKey: 0 },
          changes: [{ field: "name", from: "Equippers Koblenz", to: "Equippers KO" }],
        },
      ],
    };

    const res = await executePlan(plan, { client, state, statePath: "unused", save: noSave, now: fixedNow });
    expect(res.failed).toBeUndefined();
    expect(res.updated).toEqual(["equippers_koblenz"]);
    expect(restCalls).toEqual([]); // no REST write at all
    expect(ajaxCalls[1]?.params).toEqual({
      func: "saveMasterData",
      table: "cdb_bereich",
      id: "7", // non-empty = update that row
      col0: "bezeichnung",
      value0: "Equippers KO",
      col1: "kuerzel",
      value1: "EQKO", // carried through, not blanked
      col2: "sortkey",
      value2: "0",
    });
  });
});

describe("columns are validated against the instance's own DESCRIBE (#109 acceptance)", () => {
  it("refuses a column this instance does not report, instead of posting it silently", async () => {
    // A legacy endpoint does not 400 on an unknown colN — it just ignores it. So an unvalidated write
    // looks like a success and silently drops the field. Hard-error naming the real columns instead.
    expect(() => masterDataColumns(BEREICH_TABLE, { farbe: "blau" })).toThrow(
      /has no column "farbe" — it has: id, bezeichnung, kuerzel, sortkey/,
    );
  });

  it("skips `id` (it travels as its own parameter, not as a column)", () => {
    expect(masterDataColumns(BEREICH_TABLE, { id: 7, bezeichnung: "X" })).toEqual({
      col0: "bezeichnung",
      value0: "X",
    });
  });

  it("names what the instance DOES report when the table is missing entirely", async () => {
    const { client } = recorder();
    await expect(masterDataTable(client, "cdb_nope")).rejects.toThrow(
      /does not report a table "cdb_nope".*It reports: cdb_bereich/s,
    );
  });
});

describe("reads go through fetchOne, because GET /departments/{id} does not exist (#108)", () => {
  // Regression for a bug a live dev apply caught and no mock could: `/departments` has NO item path.
  // The default read 404s, every caller reads that as "vanished in ChurchTools", and the plan proposes
  // creating the same Bereich again — forever. A mock answers whatever path it is asked for, so this
  // only showed up against a real instance. Pinned here now.
  it("filters the collection instead of fetching an item path", async () => {
    const { client, restCalls } = recorder([{ id: 7, name: "Equippers Koblenz" }]);
    const raw = await RESOURCES.department!.fetchOne!(client, 7);
    expect(raw).toMatchObject({ id: 7, name: "Equippers Koblenz" });
    expect(restCalls).toEqual([{ method: "GET", path: "/departments" }]);
    expect(restCalls.some((c) => c.path.startsWith("/departments/"))).toBe(false);
  });

  it("returns null for an id the collection does not contain (treated as a 404 by callers)", async () => {
    const { client } = recorder([{ id: 7, name: "Equippers Koblenz" }]);
    expect(await RESOURCES.department!.fetchOne!(client, 99)).toBeNull();
  });

  it("makes a managed Bereich diff clean instead of re-proposing a create", async () => {
    const state: State = {
      version: 1,
      host: "h",
      resources: {
        equippers_koblenz: {
          type: "department",
          id: 7,
          key: "equippers_koblenz",
          fields: { name: "Equippers Koblenz", shorty: "EQKO", sortKey: 0 },
          adoptedAt: "t",
          updatedAt: "t",
        },
      },
    };
    const { client } = recorder([{ id: 7, name: "Equippers Koblenz", shorty: "EQKO", sortKey: 0 }]);
    const { actual } = await fetchActual(client as never, Object.values(state.resources));
    expect(actual.get("equippers_koblenz")).toEqual({
      name: "Equippers Koblenz",
      shorty: "EQKO",
      sortKey: 0,
    });
  });
});

describe("repeated reads and writes share their fetches", () => {
  it("reads /departments ONCE across a whole fetchActual fan-out", async () => {
    // `fetchActual` runs fetchOne per managed Bereich, concurrently — without sharing, a config with
    // N departments issues N full collection GETs on every plan AND every apply.
    const { client, restCalls } = recorder([
      { id: 7, name: "A" },
      { id: 8, name: "B" },
      { id: 9, name: "C" },
    ]);
    const spec = RESOURCES.department!;
    const ids = [7, 8, 9];
    const rows = await Promise.all(ids.map((id) => spec.fetchOne!(client, id)));
    expect(rows.map((r) => r?.id)).toEqual(ids);
    expect(restCalls).toEqual([{ method: "GET", path: "/departments" }]);
  });

  it("re-reads /departments after a write, so the shared read can never go stale", async () => {
    const { client, restCalls } = recorder([{ id: 7, name: "A" }]);
    const spec = RESOURCES.department!;
    await spec.fetchOne!(client, 7);
    await spec.writer!.update!({ client, body: { name: "A2" }, id: 7 });
    await spec.fetchOne!(client, 7);
    expect(restCalls.filter((c) => c.path === "/departments")).toHaveLength(2);
  });

  it("fetches the ~3 MB master-data registry ONCE across several writes", async () => {
    // The registry is cached per client inside masterdata.ts. The writer must therefore hand on a
    // STABLE wrapper object — a fresh literal per call misses that cache and refetches every time.
    const { client, ajaxCalls } = recorder([{ id: 7, name: "A" }]);
    const spec = RESOURCES.department!;
    await spec.writer!.update!({ client, body: { name: "A2" }, id: 7 });
    await spec.writer!.update!({ client, body: { name: "A3" }, id: 7 });
    await spec.writer!.remove!({ client, id: 7 });
    expect(ajaxCalls.filter((c) => c.params.func === "getMasterData")).toHaveLength(1);
  });
});

describe("the legacy write channel is allowlisted to one table", () => {
  // `assertNotPeople` guards REST PATHS and cannot see this channel at all, while the registry the
  // instance reports includes person master data. Enforce the one-table scope in code, not prose.
  it("refuses to save or delete any table other than cdb_bereich", async () => {
    const { client } = recorder();
    const { saveMasterData, deleteMasterData } = await import("../src/api/masterdata.js");
    await expect(saveMasterData(client, "cdb_familienstand", { bezeichnung: "X" })).rejects.toThrow(
      /Refusing to write master-data table "cdb_familienstand"/,
    );
    await expect(deleteMasterData(client, "cdb_familienstand", 1)).rejects.toThrow(
      /Refusing to write master-data table "cdb_familienstand"/,
    );
  });
});

describe("destroy deletes through the legacy verb (#108)", () => {
  it("calls deleteMasterData rather than a REST DELETE", async () => {
    const { client, ajaxCalls, restCalls } = recorder();
    await RESOURCES.department!.writer!.remove!({ client, id: 7 });
    expect(restCalls).toEqual([]);
    expect(ajaxCalls.at(-1)).toEqual({
      module: "churchdb",
      params: { func: "deleteMasterData", table: "cdb_bereich", id: "7" },
    });
  });
});

describe("the department type stays REST for reads (#108 acceptance)", () => {
  it("reads through /departments and writes through the writer hook", () => {
    const spec = RESOURCES.department!;
    expect(spec.collectionPath).toBe("/departments");
    expect(spec.itemPath(7)).toBe("/departments/7");
    expect(spec.writer).toBeDefined();
    expect(DEPARTMENT_TABLE).toBe("cdb_bereich");
  });

  it("is the only type with a custom writer", () => {
    // Pinned: the legacy surface is deliberately reached for exactly one table (#109 — the other 23
    // registry tables either have a REST write or are outside this tool's mandate).
    const withWriter = Object.entries(RESOURCES)
      .filter(([, spec]) => spec.writer !== undefined)
      .map(([type]) => type);
    expect(withWriter).toEqual(["department"]);
  });

  it("warns about the blast radius on destroy", () => {
    expect(RESOURCES.department!.destroyWarning).toMatch(/every person assigned to it/);
  });
});
