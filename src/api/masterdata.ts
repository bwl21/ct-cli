/**
 * ChurchTools' LEGACY master-data registry (#108/#109) — the write path the admin UI uses for tables
 * that have no REST write endpoint.
 *
 * `POST /index.php?q=churchdb/ajax` with `func=getMasterData` returns, among the data itself,
 * `data.masterDataTables`: a SELF-DESCRIBING registry of every editable table, keyed by a numeric id,
 * each carrying its label, shortname, physical table name and a full `DESCRIBE`-style column list.
 * Writes go to the same endpoint:
 *
 *   func=saveMasterData&table=cdb_bereich&id=&col0=bezeichnung&value0=…&col1=kuerzel&value1=…
 *   → {"status":"success","data":null}    (empty `id` creates; a non-empty `id` updates that row)
 *   func=deleteMasterData&table=cdb_bereich&id=3
 *   → {"status":"success","data":null}
 *
 * All three verbs verified live on eqrm-dev, CT 3.135.2, 2026-08-14: created a Bereich, updated it by
 * id, deleted it, and confirmed `GET /departments` reflected each step (instance left as found).
 * `deleteMasterData` is real rather than a silently-ignored unknown verb — a made-up `delMasterData`
 * against the same endpoint answered `{"status":"error","message":"Function delMasterData was not
 * defined as Function!"}`, so the endpoint validates function names.
 *
 * SCOPE. `ct` drives this registry for exactly ONE table: `cdb_bereich`. A live classification of all
 * 24 tables on eqrm-dev (2026-08-14) against the instance's own OpenAPI spec found 15 with a REST
 * write path — campuses, group types, person statuses, comment viewers, group categories and more —
 * and REST stays authoritative for every one of them. Of the 9 without, 8 are person master data or
 * field option lists outside this tool's structural mandate (marital status, nationality, custom
 * choice/selection lists, privacy-policy types, meeting days). Bereiche are the only table that is
 * both in-mandate and REST-less, which is why #109's generic driver is not built: it would have had
 * exactly one in-scope user.
 *
 * RE-PROBE on a CT major bump, per the procedure in docs/runbook-manual-surface.md — this endpoint is
 * undocumented and self-trimming in neither direction.
 */
import type { CtClient } from "./ctClient.js";

/** One column of a master-data table, straight out of the instance's `DESCRIBE`. */
export interface MasterDataColumn {
  field: string;
  type: string;
  null: string;
  key: string;
  default: string | null;
  extra: string;
}

/** One editable table as the instance describes itself. */
export interface MasterDataTable {
  id: number;
  /** Human label, e.g. "Bereich". Localised, and empty for a few internal tables. */
  bezeichnung: string;
  /** The registry's own short name, e.g. "dep". */
  shortname: string;
  /** The physical table, e.g. "cdb_bereich" — what `saveMasterData` takes as `table`. */
  tablename: string;
  /** Column name → its description. */
  desc: Record<string, MasterDataColumn>;
}

/** The physical table behind Bereiche/departments — the one table this tool writes here (#108). */
export const DEPARTMENT_TABLE = "cdb_bereich";

/** The module whose legacy AJAX endpoint serves the master-data registry. */
const MASTER_DATA_MODULE = "churchdb";

interface RawMasterData {
  masterDataTables?: Record<string, MasterDataTable>;
}

/**
 * Read the instance's own table registry, once per client.
 *
 * Cached on the client because `getMasterData` returns the whole master-data payload — ~3 MB on a
 * real instance — and a plan that writes several Bereiche would otherwise re-fetch it per write.
 */
const registryCache = new WeakMap<object, Promise<Record<string, MasterDataTable>>>();

export function masterDataTables(client: Pick<CtClient, "ajax">): Promise<Record<string, MasterDataTable>> {
  let p = registryCache.get(client);
  if (!p) {
    p = client.ajax<RawMasterData>(MASTER_DATA_MODULE, { func: "getMasterData" }).then((d) => {
      const tables = d?.masterDataTables;
      if (!tables || typeof tables !== "object") {
        throw new Error(
          `ChurchTools' master-data registry (getMasterData) returned no "masterDataTables". The ` +
            `legacy endpoint is undocumented and may have changed — re-probe it per the re-audit ` +
            `procedure in docs/runbook-manual-surface.md before trusting any master-data write.`,
        );
      }
      return tables;
    });
    registryCache.set(client, p);
  }
  return p;
}

/** Find one table by its physical name, or throw naming what the instance does report. */
export async function masterDataTable(
  client: Pick<CtClient, "ajax">,
  tablename: string,
): Promise<MasterDataTable> {
  const tables = await masterDataTables(client);
  const hit = Object.values(tables).find((t) => t.tablename === tablename);
  if (!hit) {
    const available = Object.values(tables)
      .map((t) => t.tablename)
      .sort()
      .join(", ");
    throw new Error(
      `ChurchTools' master-data registry does not report a table "${tablename}" on this instance. ` +
        `It reports: ${available}.`,
    );
  }
  return hit;
}

/**
 * Turn a field bag into `colN`/`valueN` pairs, VALIDATED against the instance's own column list.
 *
 * The validation is the point (#109's acceptance): posting an unknown `colN` to a legacy endpoint is
 * not a 400 — it is a silent partial write. So a declared field the instance does not report is a
 * hard error naming the columns it does report, and `id` is skipped because it travels as its own
 * parameter rather than as a column.
 */
export function masterDataColumns(
  table: MasterDataTable,
  fields: Record<string, unknown>,
): Record<string, string> {
  const params: Record<string, string> = {};
  let n = 0;
  for (const [name, value] of Object.entries(fields)) {
    if (name === "id") continue; // the row key, not a column — sent separately
    if (!table.desc[name]) {
      const known = Object.keys(table.desc).join(", ");
      throw new Error(
        `Master-data table "${table.tablename}" on this instance has no column "${name}" — it has: ` +
          `${known}. Refusing to post an unknown column (the legacy endpoint would accept it silently).`,
      );
    }
    if (value === undefined || value === null) continue;
    params[`col${n}`] = name;
    params[`value${n}`] = String(value);
    n += 1;
  }
  if (n === 0) {
    throw new Error(`Nothing to write to "${table.tablename}": no non-empty managed columns.`);
  }
  return params;
}

/**
 * Create or update one master-data row. An empty `id` creates; a numeric one updates that row.
 *
 * Returns nothing useful on create — CT answers `{"status":"success","data":null}` with no id — so
 * callers that need the new id must re-read the resource's REST catalog afterward. That is why the
 * department writer below matches on the name it just wrote.
 */
export async function saveMasterData(
  client: Pick<CtClient, "ajax">,
  tablename: string,
  fields: Record<string, unknown>,
  id?: number,
): Promise<void> {
  const table = await masterDataTable(client, tablename);
  await client.ajax(MASTER_DATA_MODULE, {
    func: "saveMasterData",
    table: tablename,
    id: id === undefined ? "" : String(id),
    ...masterDataColumns(table, fields),
  });
}

/**
 * Delete one master-data row. Verified to exist (see the header), but `ct apply` never deletes —
 * this is reached only from `ct destroy`, behind its own typed confirmation.
 */
export async function deleteMasterData(
  client: Pick<CtClient, "ajax">,
  tablename: string,
  id: number,
): Promise<void> {
  await masterDataTable(client, tablename); // validate the table exists before asking CT to drop a row
  await client.ajax(MASTER_DATA_MODULE, { func: "deleteMasterData", table: tablename, id: String(id) });
}
