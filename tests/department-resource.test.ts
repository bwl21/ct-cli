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

/** A client exposing REST `request`/`getAll` plus the legacy `ajax` channel, recording both. */
function recorder(departments: { id: number; name: string; shorty?: string; sortKey?: number }[] = []) {
  const ajaxCalls: { module: string; params: Record<string, string> }[] = [];
  const restCalls: { method: string; path: string; body?: unknown }[] = [];
  const client = {
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      restCalls.push({ method, path, body });
      return {} as T;
    },
    getAll: async <T>(path: string): Promise<{ data: T[] }> => {
      restCalls.push({ method: "GET", path });
      return { data: departments as T[] };
    },
    ajax: async <T>(module: string, params: Record<string, string>): Promise<T> => {
      ajaxCalls.push({ module, params });
      if (params.func === "getMasterData") return { masterDataTables: { "3": BEREICH_TABLE } } as T;
      return null as T;
    },
  };
  return { client, ajaxCalls, restCalls };
}

describe("create goes through saveMasterData, then re-reads REST for the id (#108)", () => {
  it("posts the mapped columns with an EMPTY id, then records the id from GET /departments", async () => {
    const state = emptyState("h");
    // The Bereich exists in the catalog by the time the create re-reads it.
    const { client, ajaxCalls, restCalls } = recorder([{ id: 7, name: "Equippers Koblenz" }]);
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

    // No REST write — that is the point. The only REST call is the id lookup afterwards.
    expect(restCalls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(restCalls).toEqual([{ method: "GET", path: "/departments" }]);

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

  it("fails loudly when the created Bereich cannot be identified by name afterwards", async () => {
    // saveMasterData returns no id, so the new row is found by name. Two rows sharing that name — or
    // none — must stop the apply rather than bind state to a guessed id, which would be permanent.
    const state = emptyState("h");
    const { client } = recorder([
      { id: 7, name: "Doppelt" },
      { id: 8, name: "Doppelt" },
    ]);
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
    expect(res.failed?.message).toMatch(/2 rows match it in GET \/departments/);
    expect(state.resources.doppelt).toBeUndefined();
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
